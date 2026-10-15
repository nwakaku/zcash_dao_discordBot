const { JunoClient } = require('../src/voteDesk/junoClient');
const { loadDaoSnapshot } = require('../src/voteDesk/daoSource');
const { calculateVoteMath } = require('../src/voteDesk/math');
const config = require('../src/config/voteDesk.json');

const FINAL_PASS_STATUSES = new Set(['passed', 'executed', 'execution_failed']);
const FINAL_FAIL_STATUSES = new Set(['rejected', 'closed']);

async function main() {
    const lcdUrl = process.env.VOTEDESK_LCD_URL || config.lcdUrl;
    const daoAddress = process.env.VOTEDESK_DAO_ADDRESS || config.daoAddress;
    const chain = new JunoClient(lcdUrl);
    const snapshot = await loadDaoSnapshot(chain, daoAddress);
    const results = [];

    for (const item of snapshot.proposals) {
        const status = String(item.proposal.status).toLowerCase();
        if (!FINAL_PASS_STATUSES.has(status) && !FINAL_FAIL_STATUSES.has(status)) continue;

        const computedPass = calculateVoteMath(item.proposal).passed;
        const contractPass = FINAL_PASS_STATUSES.has(status);
        results.push({
            proposal: `${item.prefix}${item.id}`,
            status,
            computedPass,
            matches: computedPass === contractPass,
        });
    }

    const mismatches = results.filter(result => !result.matches);
    console.log(JSON.stringify({
        height: snapshot.block.height.toString(),
        totalProposals: snapshot.proposals.length,
        terminalProposalsChecked: results.length,
        agreement: `${results.length - mismatches.length}/${results.length}`,
        mismatches,
    }, null, 2));

    if (mismatches.length) process.exitCode = 1;
}

main().catch(error => {
    console.error('Vote Desk backtest failed:', error);
    process.exitCode = 1;
});
