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
const { StateStore } = require('./stateStore');

const DATA_DIRECTORY = path.join(__dirname, '../../data');
const STATE_PATH = path.join(DATA_DIRECTORY, 'vote-desk-state.json');
const MAX_MESSAGE_LENGTH = 1900;

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
        channelId: process.env.VOTEDESK_CHANNEL_ID || voteDeskConfig.channelId,
        pollIntervalSeconds: Number(process.env.VOTEDESK_POLL_INTERVAL_SECONDS || voteDeskConfig.pollIntervalSeconds),
        blockTimeSeconds: Number(process.env.VOTEDESK_BLOCK_TIME_SECONDS || voteDeskConfig.blockTimeSeconds),
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

async function sendMessage(channel, content, nonVoters) {
    const options = { allowedMentions: { parse: [] } };
    if (content.length > MAX_MESSAGE_LENGTH) {
        const formattedList = nonVoters.map(shortAddress).join(', ') || 'None';
        const shortenedContent = content.replace(formattedList, 'See attached non-voters.txt');
        if (shortenedContent.length > 2000) {
            throw new Error('Vote Desk message exceeds Discord’s 2,000-character limit');
        }
        content = shortenedContent;
        options.files = [new AttachmentBuilder(
            Buffer.from(nonVoters.map(shortAddress).join('\n'), 'utf8'),
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
    await sendMessage(channel, content);
    await state.mark(key, 'unavailable');
}

async function runCycle(client, channel, config, chain, state) {
    let snapshot;
    try {
        snapshot = await loadDaoSnapshot(chain, config.daoAddress);
    } catch (error) {
        console.error('[VOTE DESK] DAO data unavailable; no stale vote figures will be posted:', error);
        if (!state.data.outagePosted) {
            const content = config.templates.outage.replace('{asOf}', new Date().toISOString());
            await sendMessage(channel, content);
            await state.setOutagePosted(true);
        }
        return;
    }
    if (state.data.outagePosted) await state.setOutagePosted(false);

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
                if (state.has(alertKey)) continue;
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
                    await sendMessage(channel, alert.content, nonVoters);
                    await state.mark(alertKey, 'sent');
                } catch (error) {
                    await publishUnavailable(channel, state, alertKey, prefix, config, error);
                }
            }
            continue;
        }

        const proposalIsNew = BigInt(item.id) > BigInt(state.data.baselineProposals[item.moduleAddress] || 0);
        if (isTerminal(proposal.status) && proposalIsNew && !state.isTracked(key)) {
            await state.track(key);
        }
        if (!isTerminal(proposal.status) || !state.isTracked(key) || state.has(`${key}:closing`)) continue;
        try {
            const summary = formatClosing(item, snapshot.block, config);
            await sendMessage(channel, summary);
            await state.mark(`${key}:closing`, 'sent');
        } catch (error) {
            await publishUnavailable(channel, state, `${key}:closing`, prefix, config, error);
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
    if (!config.channelId) {
        console.error('[VOTE DESK] Enabled, but VOTEDESK_CHANNEL_ID is not configured.');
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

    const chain = new JunoClient(config.lcdUrl);
    const state = new StateStore(STATE_PATH);
    let running = false;

    const cycle = async () => {
        if (running) return;
        running = true;
        try {
            await state.load();
            const channel = await client.channels.fetch(config.channelId);
            if (!channel?.isTextBased() || !channel.send) {
                throw new Error(`Vote Desk channel ${config.channelId} is not a text channel`);
            }
            await runCycle(client, channel, config, chain, state);
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

module.exports = { getConfig, isOpen, isTerminal, runCycle, startVoteDesk };
