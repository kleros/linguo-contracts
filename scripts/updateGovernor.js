const { deployments, ethers, getChainId } = require("hardhat");
const fetch = require("node-fetch");

const governorAddressesByChainId = {
  1: "0xe5bcEa6F87aAEe4a81f64dfDB4d30d400e0e5cf4",
};

async function main() {
  const chainId = await getChainId();
  const governorAddress = governorAddressesByChainId[chainId];
  const [deployer] = await ethers.getSigners();
  const allDeployments = await deployments.all();
  const gasPrice = await getGasPrice();

  const totalEstimatedGasCost = (
    await Promise.all(
      Object.values(allDeployments).map(({ address, abi }) => {
        const contract = new ethers.Contract(address, abi, deployer);
        return contract.estimateGas.changeGovernor(governorAddress);
      })
    )
  ).reduce((acc, current) => acc.add(current.mul(gasPrice)), ethers.BigNumber.from(0));

  const totalCost = totalEstimatedGasCost;
  console.info("Total Gas Cost:", ethers.utils.formatEther(totalCost));

  for (const [id, { address, abi }] of Object.entries(allDeployments)) {
    const contract = new ethers.Contract(address, abi, deployer);
    const tx = await contract.changeGovernor(governorAddress);
    await tx.wait();

    console.log("%s governor was updated to %s", id, governorAddress);
  }
}

async function getGasPrice(tier = "fast") {
  const response = await fetch("https://www.gasnow.org/api/v3/gas/data", {
    headers: {
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "pt-BR,en-US;q=0.7,en;q=0.3",
    },
    method: "GET",
    mode: "cors",
  });

  const body = await response.json();

  return ethers.BigNumber.from(body.data.gasPrices[tier]);
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.log(err);
    process.exit(1);
  });
