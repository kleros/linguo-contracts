module.exports = async ({getNamedAccounts, deployments}) => {
  const {deploy} = deployments;
  const {deployer} = await getNamedAccounts();

  await deploy("Linguo", {
    from: deployer,
    gas: 8000000,
    args: ["0xA8243657a1E6ad1AAf2b59c4CCDFE85fC6fD7a8B", "0x", "86400", "1000", "0", "10000", "5000", "20000"],
  });
};
