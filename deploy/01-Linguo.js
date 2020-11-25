const arbitratorExtraDataByLanguagePair = {
  "en|es": `0x000000000000000000000000000000000000000000000000000000000000000d0000000000000000000000000000000000000000000000000000000000000001`,
  "en|fr": `0x000000000000000000000000000000000000000000000000000000000000000e0000000000000000000000000000000000000000000000000000000000000001`,
  "en|pt": `0x000000000000000000000000000000000000000000000000000000000000000f0000000000000000000000000000000000000000000000000000000000000001`,
  "de|en": `0x00000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000001`,
  "en|ru": `0x00000000000000000000000000000000000000000000000000000000000000110000000000000000000000000000000000000000000000000000000000000001`,
  "en|ko": `0x00000000000000000000000000000000000000000000000000000000000000120000000000000000000000000000000000000000000000000000000000000001`,
  "en|ja": `0x00000000000000000000000000000000000000000000000000000000000000130000000000000000000000000000000000000000000000000000000000000001`,
  "en|tr": `0x00000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000001`,
  "en|zh": `0x00000000000000000000000000000000000000000000000000000000000000150000000000000000000000000000000000000000000000000000000000000001`,
};

const paramsByChainId = {
  42: {
    arbitrator: "0xA8243657a1E6ad1AAf2b59c4CCDFE85fC6fD7a8B",
    // 1 day
    reviewTimeout: "86400",
    arbitrationCostMultiplier: "10000",
    translationMultiplier: "1000",
    challengeMultiplier: "0",
    sharedStakeMultiplier: "10000",
    winnerStakeMultiplier: "5000",
    loserStakeMultiplier: "20000",
  },
  1: {
    arbitrator: "0x988b3a538b618c7a603e1c11ab82cd16dbe28069",
    // 1 week
    reviewTimeout: "604800",
    arbitrationCostMultiplier: "15000",
    translationMultiplier: "2500",
    challengeMultiplier: "0",
    sharedStakeMultiplier: "5000",
    winnerStakeMultiplier: "5000",
    loserStakeMultiplier: "10000",
  },
};

async function deployLinguo({getNamedAccounts, getChainId, deployments}) {
  const {deploy} = deployments;
  const {deployer} = await getNamedAccounts();
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
  } = paramsByChainId[chainId];

  for (const [languagePair, arbitratorExtraData] of Object.entries(arbitratorExtraDataByLanguagePair)) {
    console.log(`Deploying Linguo_${languagePair}...`);
    await deploy(`Linguo_${languagePair}`, {
      gas: 8000000,
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
