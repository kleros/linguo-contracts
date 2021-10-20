const paramsByChainId = {
  42: {
    arbitrator: "0xA8243657a1E6ad1AAf2b59c4CCDFE85fC6fD7a8B",
    reviewTimeout: "86400", // 1 day
    arbitrationCostMultiplier: "10000",
    translationMultiplier: "1000",
    challengeMultiplier: "0",
    sharedStakeMultiplier: "10000",
    winnerStakeMultiplier: "5000",
    loserStakeMultiplier: "20000",
    languagePairToExtraData: {
      "en|es": `0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001`,
      "en|fr": `0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001`,
      "en|pt": `0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001`,
      "de|en": `0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001`,
      "en|ru": `0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001`,
      "en|ko": `0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001`,
      "en|ja": `0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001`,
      "en|tr": `0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001`,
      "en|zh": `0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001`,
    },
  },
  77: {
    arbitrator: "0xb701ff19fBD9702DD7Ca099Ee7D0D42a2612baB5",
    reviewTimeout: "86400", // 1 day
    arbitrationCostMultiplier: "10000",
    translationMultiplier: "1000",
    challengeMultiplier: "0",
    sharedStakeMultiplier: "10000",
    winnerStakeMultiplier: "5000",
    loserStakeMultiplier: "20000",
    languagePairToExtraData: {
      "en|es": `0x00000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000001`,
      "en|fr": `0x00000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000001`,
      "en|pt": `0x00000000000000000000000000000000000000000000000000000000000000050000000000000000000000000000000000000000000000000000000000000001`,
      "de|en": `0x00000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000001`,
      "en|ru": `0x00000000000000000000000000000000000000000000000000000000000000070000000000000000000000000000000000000000000000000000000000000001`,
      "en|ko": `0x00000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000001`,
      "en|ja": `0x00000000000000000000000000000000000000000000000000000000000000090000000000000000000000000000000000000000000000000000000000000001`,
      "en|tr": `0x000000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000000000001`,
      "en|zh": `0x000000000000000000000000000000000000000000000000000000000000000b0000000000000000000000000000000000000000000000000000000000000001`,
    },
  },
  1: {
    arbitrator: "0x988b3a538b618c7a603e1c11ab82cd16dbe28069",
    reviewTimeout: "604800", // 1 week
    arbitrationCostMultiplier: "15000",
    translationMultiplier: "2500",
    challengeMultiplier: "0",
    sharedStakeMultiplier: "5000",
    winnerStakeMultiplier: "5000",
    loserStakeMultiplier: "10000",
    languagePairToExtraData: {
      "en|es": `0x000000000000000000000000000000000000000000000000000000000000000d0000000000000000000000000000000000000000000000000000000000000001`,
      "en|fr": `0x000000000000000000000000000000000000000000000000000000000000000e0000000000000000000000000000000000000000000000000000000000000001`,
      "en|pt": `0x000000000000000000000000000000000000000000000000000000000000000f0000000000000000000000000000000000000000000000000000000000000001`,
      "de|en": `0x00000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000001`,
      "en|ru": `0x00000000000000000000000000000000000000000000000000000000000000110000000000000000000000000000000000000000000000000000000000000001`,
      "en|ko": `0x00000000000000000000000000000000000000000000000000000000000000120000000000000000000000000000000000000000000000000000000000000001`,
      "en|ja": `0x00000000000000000000000000000000000000000000000000000000000000130000000000000000000000000000000000000000000000000000000000000001`,
      "en|tr": `0x00000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000001`,
      "en|zh": `0x00000000000000000000000000000000000000000000000000000000000000150000000000000000000000000000000000000000000000000000000000000001`,
    },
  },
  100: {
    arbitrator: "0x9C1dA9A04925bDfDedf0f6421bC7EEa8305F9002",
    reviewTimeout: "604800", // 1 week
    arbitrationCostMultiplier: "12500",
    translationMultiplier: "2500",
    challengeMultiplier: "0",
    sharedStakeMultiplier: "5000",
    winnerStakeMultiplier: "5000",
    loserStakeMultiplier: "10000",
    languagePairToExtraData: {
      "en|es": `0x00000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000001`,
      "en|fr": `0x00000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000001`,
      "en|pt": `0x00000000000000000000000000000000000000000000000000000000000000050000000000000000000000000000000000000000000000000000000000000001`,
      "de|en": `0x00000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000001`,
      "en|ru": `0x00000000000000000000000000000000000000000000000000000000000000070000000000000000000000000000000000000000000000000000000000000001`,
      "en|ko": `0x00000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000001`,
      "en|ja": `0x00000000000000000000000000000000000000000000000000000000000000090000000000000000000000000000000000000000000000000000000000000001`,
      "en|tr": `0x000000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000000000001`,
      "en|zh": `0x000000000000000000000000000000000000000000000000000000000000000b0000000000000000000000000000000000000000000000000000000000000001`,
    },
  },
};

const gasPriceByChainId = {
  77: 1000000000,
  100: 1000000000,
};

async function deployLinguo({ getNamedAccounts, getChainId, deployments }) {
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();
  const chainId = await getChainId();

  const {
    arbitrator,
    reviewTimeout,
    arbitrationCostMultiplier,
    translationMultiplier,
    challengeMultiplier,
    sharedStakeMultiplier,
    winnerStakeMultiplier,
    loserStakeMultiplier,
    languagePairToExtraData,
  } = paramsByChainId[chainId];

  for (const [languagePair, arbitratorExtraData] of Object.entries(languagePairToExtraData)) {
    console.log(`Deploying Linguo_${languagePair}...`);
    await deploy(`Linguo_${languagePair}`, {
      gas: 8000000,
      gasPrice: gasPriceByChainId[chainId],
      from: deployer,
      contract: "Linguo",
      args: [
        arbitrator,
        arbitratorExtraData,
        reviewTimeout,
        arbitrationCostMultiplier,
        translationMultiplier,
        challengeMultiplier,
        sharedStakeMultiplier,
        winnerStakeMultiplier,
        loserStakeMultiplier,
      ],
      linkedData: {
        languagePair,
      },
    });
    console.log("Done!\n");
  }
}

module.exports = deployLinguo;
