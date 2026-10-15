const PAGE_LIMIT = 30;

async function listAllProposals(client, moduleAddress) {
    const proposals = [];
    let startBefore;

    while (true) {
        const response = await client.queryContract(moduleAddress, {
            reverse_proposals: { start_before: startBefore, limit: PAGE_LIMIT },
        });
        const page = response.proposals;
        if (!Array.isArray(page)) {
            throw new Error(`Proposal module ${moduleAddress} returned an invalid proposal page`);
        }
        proposals.push(...page);
        if (page.length < PAGE_LIMIT) break;

        const lastId = page[page.length - 1]?.id;
        if (lastId === undefined || String(lastId) === String(startBefore)) {
            throw new Error(`Proposal module ${moduleAddress} returned a non-advancing page`);
        }
        startBefore = Number(lastId);
    }

    return proposals;
}

async function listAllMembers(client, groupAddress) {
    const members = [];
    let startAfter;

    while (true) {
        const response = await client.queryContract(groupAddress, {
            list_members: { start_after: startAfter, limit: PAGE_LIMIT },
        });
        const page = response.members;
        if (!Array.isArray(page)) {
            throw new Error(`CW4 group ${groupAddress} returned an invalid member page`);
        }
        members.push(...page.map(member => member.addr));
        if (page.length < PAGE_LIMIT) break;

        const lastAddress = page[page.length - 1]?.addr;
        if (!lastAddress || lastAddress === startAfter) {
            throw new Error(`CW4 group ${groupAddress} returned a non-advancing member page`);
        }
        startAfter = lastAddress;
    }

    return members;
}

async function listAllVotes(client, moduleAddress, proposalId) {
    const voters = [];
    let startAfter;

    while (true) {
        const response = await client.queryContract(moduleAddress, {
            list_votes: { proposal_id: Number(proposalId), start_after: startAfter, limit: PAGE_LIMIT },
        });
        const page = response.votes;
        if (!Array.isArray(page)) {
            throw new Error(`Proposal ${proposalId} returned an invalid vote page`);
        }
        voters.push(...page.map(vote => vote.voter));
        if (page.length < PAGE_LIMIT) break;

        const lastAddress = page[page.length - 1]?.voter;
        if (!lastAddress || lastAddress === startAfter) {
            throw new Error(`Proposal ${proposalId} returned a non-advancing vote page`);
        }
        startAfter = lastAddress;
    }

    return voters;
}

async function listSnapshotNonVoters(client, votingModuleAddress, members, voters, height) {
    const voted = new Set(voters);
    const candidates = members.filter(member => !voted.has(member));
    const powers = await Promise.all(candidates.map(address =>
        client.queryContract(votingModuleAddress, {
            voting_power_at_height: { address, height: Number(height) },
        })
    ));

    return candidates.filter((_, index) => {
        const power = powers[index]?.power;
        if (power === undefined) {
            throw new Error(`Voting module returned no snapshot power for ${candidates[index]}`);
        }
        return BigInt(power) > 0n;
    });
}

async function loadDaoSnapshot(client, daoAddress) {
    const [proposalModules, votingModuleAddress, block] = await Promise.all([
        client.queryContract(daoAddress, { proposal_modules: {} }),
        client.queryContract(daoAddress, { voting_module: {} }),
        client.latestBlock(),
    ]);

    if (!Array.isArray(proposalModules)) {
        throw new Error('DAO core returned an invalid proposal module list');
    }
    if (proposalModules.some(module => !module.address || !module.prefix)) {
        throw new Error('DAO core returned a proposal module without an address or prefix');
    }
    if (!proposalModules.length) throw new Error('DAO has no registered proposal modules');

    const [groupAddress, moduleProposals] = await Promise.all([
        client.queryContract(votingModuleAddress, { group_contract: {} }),
        Promise.all(proposalModules.map(async module => ({
            module,
            proposals: await listAllProposals(client, module.address),
        }))),
    ]);
    const proposals = moduleProposals.flatMap(({ module, proposals }) =>
        proposals.map(item => ({ ...item, moduleAddress: module.address, prefix: module.prefix }))
    );

    return {
        block,
        proposals,
        modules: proposalModules,
        groupAddress,
        votingModuleAddress,
    };
}

module.exports = {
    listAllMembers,
    listAllProposals,
    listAllVotes,
    listSnapshotNonVoters,
    loadDaoSnapshot,
};
