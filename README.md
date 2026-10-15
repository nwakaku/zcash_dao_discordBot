# ZecHub Vote Desk

Read-only Discord governance monitoring for the ZecHub DAO on Juno. The Vote Desk reads DAO DAO proposal, voting, and CW4 group contracts; it never casts votes or submits chain transactions.

## What it does

- Posts public updates in the configured governance channel at 48 and 24 hours before each open proposal expires.
- Includes yes/no/abstain, total cast, snapshot voting power, the proposal-specific support threshold and quorum, the minimum additional yes votes needed at the current no count, time remaining, and a direct proposal link.
- Includes one public list of current CW4 group members who have not voted. It sends no DMs or targeted pings.
- Posts one closing summary for proposals the bot has observed open, with the outcome, whether support and/or quorum was missed, and the vote shortfall.
- Refreshes data for every post. When a required chain query fails, it posts a data-unavailable notice instead of using stored vote figures.
- Persists deduplication and proposal tracking state in `data/vote-desk-state.json`. Keep this file on persistent storage and run only one Vote Desk cluster.

The DAO core contract is configured below; the bot discovers registered proposal modules, their prefixes, the voting module, and its CW4 group at runtime. Threshold and total voting power come from each proposal's stored values, not constants. DAO DAO's proposal stores `total_power` with the proposal start-height snapshot and the threshold in effect for that proposal.

## Setup

1. Install dependencies with `npm install`; copy `.env.example` to `.env` and set `TOKEN` and `CLIENTID`.
2. Create a Discord text channel for governance messages and give the bot permission to view and send messages there.
3. Set `VOTEDESK_ENABLED=true` and `VOTEDESK_CHANNEL_ID=<channel id>` in `.env`. It is disabled by default. Set `VOTEDESK_ENABLED=false` and restart the bot to use the maintainer kill switch.
4. Review `src/config/voteDesk.json` for the DAO, read-only LCD endpoint, poll frequency, timings, and message templates. Override the DAO/LCD or scheduler settings with the `VOTEDESK_*` variables documented in `.env.example`.
5. Run `npm test` and `npm run backtest`, then start with `npm start`. Keep the Discord token, hosting account, channel permissions, and persistent state under DAO control.

The non-voter list is based on the CW4 group roster filtered by each proposal's snapshot voting power, while vote math uses the proposal's stored power snapshot and current on-chain tally. The CW4 contract exposes the current roster, not a historical roster; members removed after a proposal snapshot cannot be enumerated from this contract alone. The current DAO proposals use time-based expirations. Height-based expirations are supported using the configured average block-time estimate.

## Validation

```bash
npm test
npm run backtest
```

The backtest compares calculated outcomes against every terminal proposal status currently returned by the DAO contracts. The PRD also references a separate 53-proposal historical file and DAO DAO UI outcomes, but that file was not present in this repository; the live-chain backtest is not a substitute for that external dataset.

## Architecture

- `src/voteDesk/junoClient.js` performs read-only Juno LCD smart queries.
- `src/voteDesk/daoSource.js` discovers DAO modules and paginates proposals, CW4 members, and proposal votes.
- `src/voteDesk/math.js` implements DAO DAO percentage, majority, quorum, absolute-percentage, and absolute-count math with integer arithmetic.
- `src/voteDesk/monitor.js` schedules channel posts, handles unavailable data, applies the kill switch, and persists deduplication.
- `src/config/voteDesk.json` contains the DAO defaults, reminder schedule, poll frequency, and editable message templates.
- `test/voteDesk.test.js` covers the vote calculation and formatting.

The original Discord.js event and command loader remains under `src/`. Its V2 component showcase commands are retained as examples but excluded from slash-command registration.
