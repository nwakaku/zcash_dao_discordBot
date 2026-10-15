function asBigInt(value, name) {
    try {
        return BigInt(value ?? 0);
    } catch {
        throw new Error(`Invalid ${name} value: ${value}`);
    }
}

function fractionFromDecimal(value) {
    const text = String(value);
    const match = /^(0|1)(?:\.(\d+))?$/.exec(text);
    if (!match) {
        throw new Error(`Invalid threshold percentage: ${text}`);
    }

    const decimals = match[2] || '';
    const denominator = 10n ** BigInt(decimals.length);
    const numerator = BigInt(match[1]) * denominator + BigInt(decimals || '0');
    if (numerator > denominator) {
        throw new Error(`Threshold percentage is greater than 1: ${text}`);
    }
    return { numerator, denominator };
}

function percentageParts(percentage) {
    if (Object.hasOwn(percentage || {}, 'majority')) {
        return { majority: true };
    }
    if (Object.hasOwn(percentage || {}, 'percent')) {
        return fractionFromDecimal(percentage.percent);
    }
    throw new Error('Unsupported DAO DAO percentage threshold');
}

function ceilDivide(numerator, denominator) {
    if (numerator <= 0n) return 0n;
    return (numerator + denominator - 1n) / denominator;
}

function requiredForPercentage(percentage, total) {
    const parts = percentageParts(percentage);
    if (parts.majority) return total / 2n + 1n;
    return ceilDivide(parts.numerator * total, parts.denominator);
}

function requiredYesWithFixedNo(yes, no, percentage) {
    if (yes + no === 0n) return 1n;
    const parts = percentageParts(percentage);
    if (parts.majority) {
        return no >= yes ? no - yes + 1n : 0n;
    }

    const remaining = parts.denominator - parts.numerator;
    if (remaining === 0n) {
        return no === 0n ? 0n : null;
    }
    const numerator = parts.numerator * no - remaining * yes;
    return ceilDivide(numerator, remaining);
}

function voteCounts(proposal) {
    const votes = proposal.votes || {};
    return {
        yes: asBigInt(votes.yes, 'yes votes'),
        no: asBigInt(votes.no, 'no votes'),
        abstain: asBigInt(votes.abstain, 'abstain votes'),
    };
}

function calculateVoteMath(proposal) {
    const threshold = proposal.threshold;
    const totalPower = asBigInt(proposal.total_power, 'snapshot total power');
    const { yes, no, abstain } = voteCounts(proposal);
    const cast = yes + no + abstain;
    let quorumNeeded = 0n;
    let supportNeeded = 0n;
    let quorumMet = true;
    let supportMet = false;
    let yesVotesStillNeeded;
    let thresholdLabel;
    let quorumLabel = 'No quorum requirement';

    if (threshold?.threshold_quorum) {
        const config = threshold.threshold_quorum;
        quorumNeeded = requiredForPercentage(config.quorum, totalPower);
        supportNeeded = requiredYesWithFixedNo(yes, no, config.threshold);
        quorumMet = cast >= quorumNeeded;
        supportMet = yes > 0n && supportNeeded === 0n;
        yesVotesStillNeeded = supportNeeded === null
            ? null
            : [supportNeeded, quorumNeeded > cast ? quorumNeeded - cast : 0n]
                .reduce((maximum, count) => count > maximum ? count : maximum, 0n);
        thresholdLabel = percentageLabel(config.threshold);
        quorumLabel = percentageLabel(config.quorum);
    } else if (threshold?.absolute_percentage) {
        const percentage = threshold.absolute_percentage.percentage;
        supportNeeded = requiredForPercentage(percentage, totalPower);
        supportMet = yes >= supportNeeded && yes > 0n;
        yesVotesStillNeeded = supportNeeded > yes ? supportNeeded - yes : 0n;
        thresholdLabel = percentageLabel(percentage);
    } else if (threshold?.absolute_count) {
        supportNeeded = asBigInt(threshold.absolute_count.threshold, 'absolute vote threshold');
        supportMet = yes >= supportNeeded && yes > 0n;
        yesVotesStillNeeded = supportNeeded > yes ? supportNeeded - yes : 0n;
        thresholdLabel = `${supportNeeded} yes votes`;
    } else {
        throw new Error('Unsupported DAO DAO proposal threshold configuration');
    }

    const quorumShortfall = quorumNeeded > cast ? quorumNeeded - cast : 0n;
    const supportShortfall = supportNeeded === null ? null : supportNeeded;

    return {
        yes,
        no,
        abstain,
        cast,
        totalPower,
        thresholdLabel,
        quorumLabel,
        quorumNeeded,
        quorumMet,
        supportNeeded,
        supportMet,
        quorumShortfall,
        supportShortfall,
        yesVotesStillNeeded,
        passed: quorumMet && supportMet,
    };
}

function percentageLabel(percentage) {
    const parts = percentageParts(percentage);
    if (parts.majority) return 'majority';
    const whole = parts.numerator * 100n;
    const percentageValue = Number(whole) / Number(parts.denominator);
    return `${Number.isInteger(percentageValue) ? percentageValue : percentageValue.toFixed(2)}%`;
}

function getFailureReason(math) {
    const reasons = [];
    if (!math.quorumMet) reasons.push('quorum');
    if (!math.supportMet) reasons.push('support threshold');
    return reasons.length ? reasons.join(' and ') : 'none';
}

module.exports = {
    calculateVoteMath,
    getFailureReason,
    percentageLabel,
};
