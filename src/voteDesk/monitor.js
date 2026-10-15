const path = require('node:path');
const { AttachmentBuilder } = require('discord.js');
const voteDeskConfig = require('../config/voteDesk.json');
const { JunoClient } = require('./junoClient');
const {
    listAllMembers,
    listAllVotes,
    listSnapshotNonVoters,
    loadDaoSnapshot,
} = require('./daoSource');
const { expirationTimestamp, formatAlert, formatClosing, proposalKey, shortAddress } = require('./format');
const { NameResolver } = require('./names');
const { StateStore } = require('./stateStore');
const { TargetStore } = require('./targetStore');

const DATA_DIRECTORY = path.join(__dirname, '../../data');
const STATE_PATH = path.join(DATA_DIRECTORY, 'vote-desk-state.json');
const TARGETS_PATH = path.join(DATA_DIRECTORY, 'vote-desk-targets.json');
const MAX_MESSAGE_LENGTH = 1900;

let runtime = null;

function getRuntime(config) {
    if (!runtime) {
        runtime = {
            chain: new JunoClient(config.lcdUrl),
            state: new StateStore(STATE_PATH),
        };
    }
    return runtime;
}

function getConfig() {
    let enabled = voteDeskConfig.enabled;
    if (process.env.VOTEDESK_ENABLED !== undefined) {
        const flag = process.env.VOTEDESK_ENABLED.toLowerCase();
        if (flag !== 'true' && flag !== 'false') {
            throw new Error('VOTEDESK_ENABLED must be either true or false');
        }
        enabled = flag === 'true';
    }

    return {
        ...voteDeskConfig,
        enabled,
        daoAddress: process.env.VOTEDESK_DAO_ADDRESS || voteDeskConfig.daoAddress,
        daoUrl: process.env.VOTEDESK_DAO_URL || voteDeskConfig.daoUrl,
        lcdUrl: process.env.VOTEDESK_LCD_URL || voteDeskConfig.lcdUrl,
        pollIntervalSeconds: Number(process.env.VOTEDESK_POLL_INTERVAL_SECONDS || voteDeskConfig.pollIntervalSeconds),
        blockTimeSeconds: Number(process.env.VOTEDESK_BLOCK_TIME_SECONDS || voteDeskConfig.blockTimeSeconds),
        pfpkApiUrl: process.env.VOTEDESK_PFPK_API_URL || voteDeskConfig.pfpkApiUrl || 'https://pfpk.daodao.zone',
    };
}

function isOpen(status) {
    return String(status).toLowerCase() === 'open';
}

function isTerminal(status) {
    return ['passed', 'rejected', 'executed', 'closed', 'execution_failed'].includes(String(status).toLowerCase());
}

function dueReminders(proposal, block, config) {
    const expiration = expirationTimestamp(
        proposal.proposal.expiration,
        block.height,
        config.blockTimeSeconds,
        block.time.getTime()
    );
    const secondsRemaining = (expiration - block.time.getTime()) / 1000;
    return config.reminderHours
        .filter(hours => secondsRemaining <= hours * 3600 && secondsRemaining > 0)
        .map(hours => `${proposalKey(proposal)}:${hours}h`);
}

async function sendMessage(channel, content, nonVoters, config) {
    const options = { allowedMentions: { parse: [] } };
    if (content.length > MAX_MESSAGE_LENGTH) {
        if (!Array.isArray(nonVoters)) {
            throw new Error('Vote Desk message exceeds Discord’s 2,000-character limit');
        }
        const nameResolver = new NameResolver({
            members: config?.members || {},
            pfpkApiUrl: config?.pfpkApiUrl || 'https://pfpk.daodao.zone',
        });
        const formattedList = nonVoters.map((addr) => nameResolver.resolveSync(addr)).join(', ') || 'None';
        const attachmentList = nonVoters.map((addr) => nameResolver.resolveSync(addr)).join('\n') || 'None';
        const shortenedContent = content.replace(formattedList, 'See attached non-voters.txt');
        if (shortenedContent.length > 2000) {
            throw new Error('Vote Desk message exceeds Discord’s 2,000-character limit');
        }
        content = shortenedContent;
        options.files = [new AttachmentBuilder(
            Buffer.from(attachmentList, 'utf8'),
            { name: 'non-voters.txt' }
        )];
    }
    return channel.send({ content, ...options });
}

async function publishUnavailable(channel, state, key, proposalName, config, error) {
    console.error(`[VOTE DESK] ${proposalName} data unavailable:`, error);
    if (state.unavailableWasPosted(key) || state.has(key)) return;
    const content = config.templates.unavailable
        .replace('{proposal}', proposalName)
        .replace('{asOf}', new Date().toISOString());
    await sendMessage(channel, content, undefined, config);
    await state.mark(key, 'unavailable');
}

async function runCycle(client, channel, config, chain, state, scope = 'default') {
    const scoped = (key) => `${scope}:${key}`;
    let snapshot;
    try {
        snapshot = await loadDaoSnapshot(chain, config.daoAddress);
    } catch (error) {
        console.error('[VOTE DESK] DAO data unavailable; no stale vote figures will be posted:', error);
        if (!state.outageWasPosted(scope)) {
            const content = config.templates.outage.replace('{asOf}', new Date().toISOString());
            await sendMessage(channel, content, undefined, config);
            await state.markOutage(scope);
        }
        return;
    }
    if (state.outageWasPosted(scope)) await state.clearOutage(scope);

    const proposals = snapshot.proposals;
    let initializedBaseline = false;
    for (const module of snapshot.modules) {
        if (!Object.hasOwn(state.data.baselineProposals, module.address)) {
            const maximum = proposals
                .filter(item => item.moduleAddress === module.address)
                .reduce((value, item) => BigInt(item.id) > value ? BigInt(item.id) : value, 0n);
            state.data.baselineProposals[module.address] = maximum.toString();
            initializedBaseline = true;
        }
    }
    if (initializedBaseline) await state.save();

    const due = proposals.filter(item => isOpen(item.proposal.status) && dueReminders(item, snapshot.block, config).length);
    let members;
    let memberError;
    if (due.length) {
        try {
            members = await listAllMembers(chain, snapshot.groupAddress);
        } catch (error) {
            memberError = error;
        }
    }
    const nonVotersByProposal = new Map();

    for (const item of proposals) {
        const proposal = item.proposal;
        const prefix = `${item.prefix}${item.id}`;
        const key = proposalKey(item);

        if (isOpen(proposal.status)) {
            await state.track(key);
            const dueKeys = dueReminders(item, snapshot.block, config);
            for (const alertKey of dueKeys) {
                if (state.has(scoped(alertKey))) continue;
                try {
                    if (memberError) throw memberError;
                    if (!nonVotersByProposal.has(key)) {
                        nonVotersByProposal.set(key, (async () => {
                            const voters = await listAllVotes(chain, item.moduleAddress, item.id);
                            return listSnapshotNonVoters(
                                chain,
                                snapshot.votingModuleAddress,
                                members,
                                voters,
                                proposal.start_height
                            );
                        })());
                    }
                    const nonVoters = await nonVotersByProposal.get(key);
                    const alert = formatAlert(item, nonVoters, snapshot.block, config);
                    await sendMessage(channel, alert.content, nonVoters, config);
                    for (const k of dueKeys) {
                        await state.mark(scoped(k), 'sent');
                    }
                    break;
                } catch (error) {
                    await publishUnavailable(channel, state, scoped(alertKey), prefix, config, error);
                }
            }
            continue;
        }

        const proposalIsNew = BigInt(item.id) > BigInt(state.data.baselineProposals[item.moduleAddress] || 0);
        if (isTerminal(proposal.status) && proposalIsNew && !state.isTracked(key)) {
            await state.track(key);
        }
        if (!isTerminal(proposal.status) || !state.isTracked(key) || state.has(scoped(`${key}:closing`))) continue;
        try {
            const summary = formatClosing(item, snapshot.block, config);
            await sendMessage(channel, summary, undefined, config);
            await state.mark(scoped(`${key}:closing`), 'sent');
        } catch (error) {
            await publishUnavailable(channel, state, scoped(`${key}:closing`), prefix, config, error);
        }
    }

    let baselineChanged = false;
    for (const module of snapshot.modules) {
        const maximum = proposals
            .filter(item => item.moduleAddress === module.address)
            .reduce((value, item) => BigInt(item.id) > value ? BigInt(item.id) : value, 0n);
        const previous = BigInt(state.data.baselineProposals[module.address] || 0);
        if (maximum > previous) {
            state.data.baselineProposals[module.address] = maximum.toString();
            baselineChanged = true;
        }
    }
    if (baselineChanged) await state.save();
}

function matchesProposal(item, filter) {
    if (!filter) return true;
    const needle = String(filter).trim().toUpperCase();
    if (!needle) return true;
    return `${item.prefix}${item.id}`.toUpperCase() === needle || String(item.id) === needle;
}

async function runManualPost(channel, config, chain, { proposal } = {}) {
    const snapshot = await loadDaoSnapshot(chain, config.daoAddress);
    const openProposals = snapshot.proposals.filter(item => isOpen(item.proposal.status));
    const targets = openProposals.filter(item => matchesProposal(item, proposal));
    if (!targets.length) {
        return { posted: 0, proposals: [], openCount: openProposals.length };
    }

    const members = await listAllMembers(chain, snapshot.groupAddress);
    const posted = [];
    for (const item of targets) {
        const voters = await listAllVotes(chain, item.moduleAddress, item.id);
        const nonVoters = await listSnapshotNonVoters(
            chain,
            snapshot.votingModuleAddress,
            members,
            voters,
            item.proposal.start_height
        );
        const alert = formatAlert(item, nonVoters, snapshot.block, config);
        await sendMessage(channel, alert.content, nonVoters, config);
        posted.push(`${item.prefix}${item.id}`);
    }

    return { posted: posted.length, proposals: posted, openCount: openProposals.length };
}

function startVoteDesk(client) {
    let config;
    try {
        config = getConfig();
    } catch (error) {
        console.error('[VOTE DESK] Configuration error:', error);
        return;
    }
    if (!config.enabled) {
        console.log('[VOTE DESK] Disabled by configuration.');
        return;
    }
    if (
        !config.daoAddress ||
        !config.lcdUrl ||
        !config.daoUrl ||
        !Number.isInteger(config.pollIntervalSeconds) ||
        config.pollIntervalSeconds < 30 ||
        !Number.isFinite(config.blockTimeSeconds) ||
        config.blockTimeSeconds <= 0
    ) {
        console.error('[VOTE DESK] Invalid DAO address, LCD URL, DAO URL, poll interval, or block-time estimate.');
        return;
    }
    if (client.cluster && client.cluster.id !== 0) return;

    const { chain, state } = getRuntime(config);
    const targets = new TargetStore(TARGETS_PATH);
    let running = false;

    const postToTarget = async (channelId) => {
        const channel = await client.channels.fetch(channelId);
        if (!channel?.isTextBased() || !channel.send) {
            throw new Error(`Vote Desk channel ${channelId} is not a text channel`);
        }
        await runCycle(client, channel, config, chain, state, channelId);
    };

    const cycle = async () => {
        if (running) return;
        running = true;
        try {
            await state.load();
            await targets.load();
            const entries = Object.entries(targets.all());
            if (!entries.length) {
                console.log('[VOTE DESK] No target channels configured; nothing to post. Use /proposals channel set.');
                return;
            }
            for (const [, channelId] of entries) {
                try {
                    await postToTarget(channelId);
                } catch (error) {
                    console.error(`[VOTE DESK] Target ${channelId} failed:`, error);
                }
            }
        } catch (error) {
            console.error('[VOTE DESK] Poll failed:', error);
        } finally {
            running = false;
        }
    };

    void cycle();
    const timer = setInterval(() => void cycle(), config.pollIntervalSeconds * 1000);
    timer.unref();
    console.log(`[VOTE DESK] Monitoring DAO ${config.daoAddress} every ${config.pollIntervalSeconds}s.`);
}

module.exports = { getConfig, getRuntime, isOpen, isTerminal, runCycle, runManualPost, startVoteDesk, TARGETS_PATH };
