require("dotenv/config");
const { task } = require("hardhat/config");

require("@nomiclabs/hardhat-ethers");
require("@nomiclabs/hardhat-web3");
require("@nomiclabs/hardhat-truffle5");
require("hardhat-deploy");

task("accounts", "Prints the list of accounts", async (_, { ethers }) => {
  const accounts = await ethers.getSigners();

  for (const account of accounts) {
    console.log(await account.getAddress());
  }
});

const PRIVATE_KEYS = JSON.parse(process.env.PRIVATE_KEYS);

module.exports = {
  solidity: {
    version: "0.7.4",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  paths: {
    sources: "./contracts/0.7.x",
  },
  networks: {
    hardhat: {
      live: false,
      saveDeployments: false,
      tags: ["test", "local"],
    },
    kovan: {
      chainId: 42,
      url: `https://kovan.infura.io/v3/${process.env.INFURA_API_KEY}`,
      accounts: [PRIVATE_KEYS[42]],
      live: true,
      saveDeployments: true,
      tags: ["staging"],
    },
    mainnet: {
      chainId: 1,
      url: `https://mainnet.infura.io/v3/${process.env.INFURA_API_KEY}`,
      accounts: [PRIVATE_KEYS[1]],
      live: true,
      saveDeployments: true,
      tags: ["production"],
    },
    sokol: {
      chainId: 77,
      url: "https://sokol.poa.network",
      accounts: [PRIVATE_KEYS[77]],
      live: true,
      saveDeployments: true,
      tags: ["staging"],
    },
    xdai: {
      chainId: 100,
      url: "https://rpc.xdaichain.com",
      accounts: [PRIVATE_KEYS[100]],
      live: true,
      saveDeployments: true,
      tags: ["production"],
    },
  },
  namedAccounts: {
    deployer: {
      default: 0,
    },
  },
};
