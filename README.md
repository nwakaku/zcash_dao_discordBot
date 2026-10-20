# ZecHub Vote Desk

Read-only Discord governance monitoring for the ZecHub DAO on Juno. The Vote Desk reads DAO DAO proposal, voting, and CW4 group contracts; it never casts votes or submits chain transactions.

## Rationale

DAO DAO governance for ZecHub happens on-chain on Juno, but members live in Discord. Proposal deadlines and live tallies are easy to miss there, so people often learn a vote has closed only after the fact — and turnout suffers. The Vote Desk bridges that gap: it surfaces every open proposal's countdown, current counts, quorum and support requirements, and remaining non-voters directly in the server's governance channel, then posts a final outcome summary.

The design follows four principles:

- **Read-only by design.** The bot never casts votes or submits chain transactions, so it cannot move funds or influence outcomes. It is safe to hand over to DAO control.
- **No noise.** Deduplication state guarantees exactly one reminder per interval per channel, manual posts don't disturb the schedule, and each server opts in to one channel of its choosing. There are no DMs and no targeted pings — only public, opt-in channel posts.
- **Honest data.** Every post is refreshed from chain first; if a required query fails, the bot posts a data-unavailable notice instead of showing stale figures.
- **Fail-safe.** A maintainer kill switch (`VOTEDESK_ENABLED=false`) stops all scheduled monitoring instantly.

In one line: it raises DAO turnout by making voting deadlines and live tallies impossible to miss in Discord — without ever touching the chain or spamming members.

Invite Live into Your Server - https://discord.com/oauth2/authorize?client_id=1560216690212470784 

The sections below describe what it does and how to run it.

## What it does

- Posts public updates in the configured governance channel at 48 and 24 hours before each open proposal expires.
- Includes yes/no/abstain, total cast, snapshot voting power, the proposal-specific support threshold and quorum, the minimum additional yes votes needed at the current no count, time remaining, and a direct proposal link.
- Includes one public list of current CW4 group members who have not voted. It sends no DMs or targeted pings.
- Posts one closing summary for proposals the bot has observed open, with the outcome, whether support and/or quorum was missed, and the vote shortfall.
- Refreshes data for every post. When a required chain query fails, it posts a data-unavailable notice instead of using stored vote figures.
- Supports the `/proposals post` slash command to post the current alert on demand, without waiting for the reminder window.
- Each server chooses where scheduled alerts post with `/proposals channel set` (admins only); a server with no channel configured receives no scheduled posts.
- Persists deduplication and proposal tracking state in `data/vote-desk-state.json`, and per-server channels in `data/vote-desk-targets.json`. Keep these files on persistent storage and run only one Vote Desk cluster.

The DAO core contract is configured below; the bot discovers registered proposal modules, their prefixes, the voting module, and its CW4 group at runtime. Threshold and total voting power come from each proposal's stored values, not constants. DAO DAO's proposal stores `total_power` with the proposal start-height snapshot and the threshold in effect for that proposal.

## Setup

1. Install dependencies with `npm install`; copy `.env.example` to `.env` and set `TOKEN` and `CLIENTID`.
2. Invite the bot with the `bot` and `applications.commands` scopes and the permissions to view channels, send messages, embed links, attach files, and read message history. Enable the Server Members and Message Content privileged intents in the Discord Developer Portal.
3. Set `VOTEDESK_ENABLED=true` in `.env`. It is disabled by default. Set `VOTEDESK_ENABLED=false` and restart the bot to use the maintainer kill switch.
4. In each server that should receive scheduled alerts, an admin runs `/proposals channel set channel:#governance`. A server with no channel set receives no scheduled posts. `/proposals post` still works anywhere on demand.
5. Review `src/config/voteDesk.json` for the DAO, read-only LCD endpoint, poll frequency, timings, and message templates. Override the DAO/LCD or scheduler settings with the `VOTEDESK_*` variables documented in `.env.example`.
6. Run `npm test` and `npm run backtest`, then start with `npm start`. Keep the Discord token, hosting account, channel permissions, and persistent state under DAO control.

The non-voter list is based on the CW4 group roster filtered by each proposal's snapshot voting power, while vote math uses the proposal's stored power snapshot and current on-chain tally. The CW4 contract exposes the current roster, not a historical roster; members removed after a proposal snapshot cannot be enumerated from this contract alone. The current DAO proposals use time-based expirations. Height-based expirations are supported using the configured average block-time estimate.

## Manual trigger

Use `/proposals post` to post Vote Desk alerts immediately, independent of the `reminderHours` schedule. By default it posts one alert for every open proposal in the channel where the command is run; pass `proposal` (for example `A185` or `185`) to post a single proposal, or `channel` to post elsewhere. Anyone may run the command, and it is rate-limited to one post per user every 30 seconds.

Manual posts do not consume or alter the scheduled `48`/`24` hour reminder state, so the timed reminders still fire as normal. The command is also available while `VOTEDESK_ENABLED=false`, as long as a usable channel and reachable DAO/LCD endpoints exist.

Slash commands are registered per guild the bot is in, so they appear instantly and are added automatically when the bot joins a new server.

## Channel configuration

An admin sets a server's scheduled alert channel with `/proposals channel set channel:#governance`, and can view or disable it with `/proposals channel show` and `/proposals channel clear`. Each server stores one channel in `data/vote-desk-targets.json`. Deduplication is tracked per channel, so adding a channel later does not replay old reminders for that server, while other servers keep their own post history.

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
- `src/voteDesk/monitor.js` schedules per-channel posts, handles unavailable data, applies the kill switch, exposes the on-demand `/proposals post` helper, and persists deduplication.
- `src/voteDesk/stateStore.js` persists global proposal tracking and per-channel deduplication.
- `src/voteDesk/targetStore.js` persists each server's scheduled alert channel in `data/vote-desk-targets.json`.
- `src/slashCommands/VoteDesk/trigger.js` registers `/proposals post` and the `/proposals channel` group, with the post cooldown and admin checks.
- `src/handlers/slash.js` loads commands and registers them per guild; `src/events/client/ready.js` and `guildCreate.js` register for existing and newly joined servers.
- `src/config/voteDesk.json` contains the DAO defaults, reminder schedule, poll frequency, and editable message templates.
- `test/voteDesk.test.js` covers the vote calculation, formatting, scheduled posting, manual posting, target storage, and per-channel deduplication.

The original Discord.js event and command loader remains under `src/`. Its V2 component showcase commands are retained as examples but excluded from slash-command registration.

Invite to Server - https://discord.com/oauth2/authorize?client_id=1560216690212470784 