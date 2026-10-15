const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { calculateVoteMath } = require('../src/voteDesk/math');
const { formatDuration, shortAddress } = require('../src/voteDesk/format');
const { runCycle, runManualPost } = require('../src/voteDesk/monitor');
const { listSnapshotNonVoters } = require('../src/voteDesk/daoSource');
const { StateStore } = require('../src/voteDesk/stateStore');
const { TargetStore } = require('../src/voteDesk/targetStore');

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
        reminderHours: [10000, 5000],
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

test('manually posts an alert outside the reminder window without touching state', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vote-desk-manual-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const state = await new StateStore(path.join(directory, 'state.json')).load();
    const now = new Date();
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
            if (address === 'group' && query.list_members) return { members: [{ addr: member, weight: 1 }] };
            if (address === 'proposal' && query.reverse_proposals) {
                return {
                    proposals: [{
                        id: 1,
                        proposal: {
                            title: 'Sample proposal',
                            status: 'open',
                            expiration: { at_time: String(BigInt(now.getTime() + 1000 * 3600_000) * 1_000_000n) },
                            threshold,
                            total_power: '2',
                            start_height: 90,
                            votes: { yes: '0', no: '0', abstain: '0' },
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
        reminderHours: [1],
        templates: {
            alert: 'Alert {proposal}: {yesNeeded} needed. Not voted: {nonVoters}',
            closing: 'Closing {proposal}: {outcome}',
            unavailable: 'Data unavailable for {proposal}',
            outage: 'DAO data unavailable',
        },
    };

    const result = await runManualPost(channel, config, chain, {});
    assert.equal(result.posted, 1);
    assert.deepEqual(result.proposals, ['A1']);
    assert.equal(channelMessages.length, 1);
    assert.match(channelMessages[0].content, /A1/);
    assert.deepEqual(state.data.posts, {});
});

test('target store round-trips per-guild channel mappings', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vote-desk-targets-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'targets.json');

    const store = await new TargetStore(file).load();
    assert.equal(store.get('guild-a'), null);

    await store.set('guild-a', 'channel-1');
    await store.set('guild-b', 'channel-2');
    assert.equal(store.get('guild-a'), 'channel-1');
    assert.deepEqual(store.all(), { 'guild-a': 'channel-1', 'guild-b': 'channel-2' });

    const reloaded = await new TargetStore(file).load();
    assert.equal(reloaded.get('guild-b'), 'channel-2');

    await reloaded.clear('guild-a');
    assert.equal(reloaded.get('guild-a'), null);
    const afterClear = await new TargetStore(file).load();
    assert.deepEqual(afterClear.all(), { 'guild-b': 'channel-2' });
});

test('deduplicates reminders independently per target scope', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vote-desk-scope-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const state = await new StateStore(path.join(directory, 'state.json')).load();
    const now = new Date();
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
            if (address === 'group' && query.list_members) return { members: [{ addr: member, weight: 1 }] };
            if (address === 'proposal' && query.reverse_proposals) {
                return {
                    proposals: [{
                        id: 1,
                        proposal: {
                            title: 'Sample proposal',
                            status: 'open',
                            expiration: { at_time: String(BigInt(now.getTime() + 47 * 3600_000) * 1_000_000n) },
                            threshold,
                            total_power: '2',
                            start_height: 90,
                            votes: { yes: '0', no: '0', abstain: '0' },
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
        reminderHours: [48],
        templates: {
            alert: 'Alert {proposal}: {yesNeeded} needed. Not voted: {nonVoters}',
            closing: 'Closing {proposal}: {outcome}',
            unavailable: 'Data unavailable for {proposal}',
            outage: 'DAO data unavailable',
        },
    };

    await runCycle(undefined, channel, config, chain, state, 'guild-a');
    await runCycle(undefined, channel, config, chain, state, 'guild-a');
    assert.equal(channelMessages.length, 1);

    await runCycle(undefined, channel, config, chain, state, 'guild-b');
    assert.equal(channelMessages.length, 2);

    assert.equal(state.has('guild-a:proposal:1:48h'), true);
    assert.equal(state.has('guild-b:proposal:1:48h'), true);
});
