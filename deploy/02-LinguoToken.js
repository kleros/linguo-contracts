module.exports = async ({getNamedAccounts, deployments}) => {
  const {deploy} = deployments;
  const {deployer} = await getNamedAccounts();

  await deploy("LinguoToken", {
    from: deployer,
    gas: 8000000,
    args: [
      "0xA8243657a1E6ad1AAf2b59c4CCDFE85fC6fD7a8B",
      "0x",
      "0xd0A1E359811322d97991E03f863a0C30C2cF029C",
      "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
      "86400",
      "1000",
      "10000",
      "5000",
      "20000",
    ],
  });
};
