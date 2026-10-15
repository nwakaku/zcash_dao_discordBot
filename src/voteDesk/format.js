const { calculateVoteMath, getFailureReason } = require('./math');
const { NameResolver } = require('./names');

function formatInteger(value) {
    return BigInt(value).toLocaleString('en-US');
}

function shortAddress(address) {
    if (address.length <= 16) return address;
    return `${address.slice(0, 8)}...${address.slice(-6)}`;
}

function createNameResolver(config) {
    return new NameResolver({
        members: config.members || {},
        pfpkApiUrl: config.pfpkApiUrl || config.pfpkApiUrl || 'https://pfpk.daodao.zone',
    });
}

function formatDuration(seconds) {
    const totalSeconds = Math.max(0, Math.floor(seconds));
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const parts = [];
    if (days) parts.push(`${days}d`);
    if (hours || days) parts.push(`${hours}h`);
    parts.push(`${minutes}m`);
    return parts.join(' ');
}

function expirationTimestamp(expiration, currentHeight, blockTimeSeconds, currentTimeMs = Date.now()) {
    if (expiration?.at_time !== undefined) {
        return Number(BigInt(expiration.at_time) / 1_000_000n);
    }
    if (expiration?.at_height !== undefined) {
        const remainingBlocks = BigInt(expiration.at_height) - BigInt(currentHeight);
        return currentTimeMs + Number(remainingBlocks) * blockTimeSeconds * 1000;
    }
    throw new Error('Unsupported DAO DAO proposal expiration');
}

function proposalKey(proposal) {
    return `${proposal.moduleAddress}:${proposal.id}`;
}

function proposalUrl(daoUrl, proposal) {
    return `${daoUrl.replace(/\/+$/, '')}/proposals/${proposal.prefix}${proposal.id}`;
}

function fillTemplate(template, values) {
    return template.replace(/\{([a-zA-Z]+)\}/g, (_, key) => String(values[key] ?? ''));
}

function formatAlert(proposalResponse, voters, block, config) {
    const proposal = proposalResponse.proposal;
    const math = calculateVoteMath(proposal);
    const expiresAt = expirationTimestamp(proposal.expiration, block.height, config.blockTimeSeconds, block.time.getTime());
    const remainingSeconds = Math.max(0, (expiresAt - block.time.getTime()) / 1000);
    const nameResolver = createNameResolver(config);
    const nonVoterNames = voters.map((addr) => nameResolver.resolveSync(addr)).join(', ') || 'None';
    const values = {
        title: proposal.title,
        proposal: `${proposalResponse.prefix}${proposalResponse.id}`,
        asOf: block.time.toISOString(),
        yes: formatInteger(math.yes),
        no: formatInteger(math.no),
        abstain: formatInteger(math.abstain),
        cast: formatInteger(math.cast),
        totalPower: formatInteger(math.totalPower),
        quorumComparison: math.quorumLabel === 'No quorum requirement'
            ? 'No quorum requirement.'
            : `${formatInteger(math.cast)} / ${formatInteger(math.quorumNeeded)} cast voting power required (${math.quorumLabel} of ${formatInteger(math.totalPower)} snapshot power).`,
        quorum: math.quorumLabel,
        threshold: math.thresholdLabel,
        yesNeeded: math.yesVotesStillNeeded === null ? 'unreachable' : formatInteger(math.yesVotesStillNeeded),
        timeRemaining: formatDuration(remainingSeconds),
        url: proposalUrl(config.daoUrl, proposalResponse),
        nonVoters: nonVoterNames,
    };
    return { content: fillTemplate(config.templates.alert, values), nonVoters: voters };
}

function formatClosing(proposalResponse, block, config) {
    const proposal = proposalResponse.proposal;
    const math = calculateVoteMath(proposal);
    const status = String(proposal.status).toLowerCase();
    const outcome = status === 'executed'
        ? 'Passed and executed'
        : status === 'execution_failed'
            ? 'Passed; execution failed'
            : status === 'passed'
                ? 'Passed'
                : 'Did not pass';
    const reason = getFailureReason(math);
    let shortfall;
    if (math.passed) {
        shortfall = 'None; all requirements were met.';
    } else {
        const parts = [];
        if (math.quorumShortfall > 0n) {
            parts.push(`${formatInteger(math.quorumShortfall)} cast vote${math.quorumShortfall === 1n ? '' : 's'} short of quorum`);
        }
        if (math.supportShortfall === null) {
            parts.push('the support threshold was unreachable');
        } else if (math.supportShortfall > 0n) {
            parts.push(`${formatInteger(math.supportShortfall)} additional yes vote${math.supportShortfall === 1n ? '' : 's'} needed for support`);
        }
        shortfall = parts.join('; ') || 'No vote shortfall under the configured thresholds.';
    }

    return fillTemplate(config.templates.closing, {
        title: proposal.title,
        proposal: `${proposalResponse.prefix}${proposalResponse.id}`,
        outcome,
        reason,
        quorumResult: math.quorumMet
            ? `met (${formatInteger(math.cast)} cast; ${formatInteger(math.quorumNeeded)} required)`
            : `missed by ${formatInteger(math.quorumShortfall)} cast votes`,
        supportResult: math.supportMet
            ? `met (${math.thresholdLabel})`
            : `missed (${math.thresholdLabel})`,
        shortfall,
        asOf: block.time.toISOString(),
        url: proposalUrl(config.daoUrl, proposalResponse),
    });
}

module.exports = {
    expirationTimestamp,
    fillTemplate,
    formatAlert,
    formatClosing,
    formatDuration,
    proposalKey,
    shortAddress,
};
