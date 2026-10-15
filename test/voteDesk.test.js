const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { calculateVoteMath } = require('../src/voteDesk/math');
const { formatDuration, shortAddress } = require('../src/voteDesk/format');
const { runCycle } = require('../src/voteDesk/monitor');
const { listSnapshotNonVoters } = require('../src/voteDesk/daoSource');
const { StateStore } = require('../src/voteDesk/stateStore');

const threshold = {
    threshold_quorum: {
        threshold: { percent: '0.67' },
        quorum: { percent: '0.4' },
    },
};

test('calculates yes votes needed for current ZecHub proposal tally', () => {
    const math = calculateVoteMath({
        threshold,
        total_power: '23',
        votes: { yes: '1', no: '4', abstain: '0' },
    });
    assert.equal(math.yesVotesStillNeeded, 8n);
    assert.equal(math.quorumNeeded, 10n);
    assert.equal(math.quorumShortfall, 5n);
    assert.equal(math.passed, false);
});

test('abstain counts toward quorum but is excluded from the yes/no ratio', () => {
    const math = calculateVoteMath({
        threshold,
        total_power: '23',
        votes: { yes: '2', no: '1', abstain: '7' },
    });
    assert.equal(math.cast, 10n);
    assert.equal(math.quorumMet, true);
    assert.equal(math.yesVotesStillNeeded, 1n);
});

test('uses strict majority semantics from DAO DAO', () => {
    const math = calculateVoteMath({
        threshold: {
            threshold_quorum: {
                threshold: { majority: {} },
                quorum: { percent: '0.4' },
            },
        },
        total_power: '10',
        votes: { yes: '2', no: '2', abstain: '0' },
    });
    assert.equal(math.yesVotesStillNeeded, 1n);
});

test('requires a yes vote when there are no yes or no ballots', () => {
    const math = calculateVoteMath({
        threshold,
        total_power: '23',
        votes: { yes: '0', no: '0', abstain: '10' },
    });
    assert.equal(math.yesVotesStillNeeded, 1n);
    assert.equal(math.supportMet, false);
});

test('excludes current group members without power at the proposal snapshot', async () => {
    const client = {
        async queryContract(address, query) {
            assert.equal(address, 'voting');
            assert.equal(query.voting_power_at_height.height, 100);
            return { power: query.voting_power_at_height.address === 'eligible' ? '1' : '0' };
        },
    };
    const members = await listSnapshotNonVoters(client, 'voting', ['eligible', 'joined-later'], [], 100n);
    assert.deepEqual(members, ['eligible']);
});

test('supports DAO DAO absolute percentage thresholds against snapshot power', () => {
    const math = calculateVoteMath({
        threshold: { absolute_percentage: { percentage: { percent: '0.67' } } },
        total_power: '23',
        votes: { yes: '10', no: '2', abstain: '1' },
    });
    assert.equal(math.yesVotesStillNeeded, 6n);
    assert.equal(math.quorumNeeded, 0n);
});

test('formats durations and shortened member addresses', () => {
    assert.equal(formatDuration(90061), '1d 1h 1m');
    assert.equal(shortAddress('juno13hpzs4dk6wcufqpa4nkk47yv28hkfdxq86shj8'), 'juno13hp...86shj8');
});

test('publishes one public reminder and a closing summary without replaying archive history', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vote-desk-test-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const state = await new StateStore(path.join(directory, 'state.json')).load();
    const now = new Date();
    let status = 'open';
    let votes = { yes: '0', no: '0', abstain: '0' };
    const member = 'juno13hpzs4dk6wcufqpa4nkk47yv28hkfdxq86shj8';
    const chain = {
        async latestBlock() {
            return { height: 100n, time: now };
        },
        async queryContract(address, query) {
            if (address === 'dao' && query.proposal_modules) {
                return [{ address: 'proposal', prefix: 'A', status: 'enabled' }];
            }
            if (address === 'dao' && query.voting_module) return 'voting';
            if (address === 'voting' && query.group_contract) return 'group';
            if (address === 'voting' && query.voting_power_at_height) return { power: '1' };
            if (address === 'group') return { members: [{ addr: member, weight: 1 }] };
            if (address === 'proposal' && query.reverse_proposals) {
                return {
                    proposals: [{
                        id: 1,
                        proposal: {
                            title: 'Sample proposal',
                            status,
                            expiration: { at_time: String(BigInt(now.getTime() + 47 * 3600_000) * 1_000_000n) },
                            threshold,
                            total_power: '2',
                            start_height: 90,
                            votes,
                        },
                    }],
                };
            }
            if (address === 'proposal' && query.list_votes) return { votes: [] };
            throw new Error(`Unexpected mock query: ${address}`);
        },
    };
    const channelMessages = [];
    const channel = {
        async send(message) {
            channelMessages.push(message);
        },
    };
    const config = {
        daoAddress: 'dao',
        daoUrl: 'https://daodao.zone/dao/dao',
        blockTimeSeconds: 6,
        reminderHours: [48, 24],
        templates: {
            alert: 'Alert {proposal}: {yesNeeded} needed. Not voted: {nonVoters} ({quorumComparison})',
            closing: 'Closing {proposal}: {outcome}; {shortfall}',
            unavailable: 'Data unavailable for {proposal}',
            outage: 'DAO data unavailable',
        },
    };

    await runCycle(undefined, channel, config, chain, state);
    await runCycle(undefined, channel, config, chain, state);
    assert.equal(channelMessages.length, 1);
    assert.match(channelMessages[0].content, /A1/);
    assert.match(channelMessages[0].content, /juno13hp\.\.\.86shj8/);

    status = 'passed';
    votes = { yes: '2', no: '0', abstain: '0' };
    await runCycle(undefined, channel, config, chain, state);
    assert.equal(channelMessages.length, 2);
    assert.match(channelMessages[1].content, /Closing A1: Passed/);
});
