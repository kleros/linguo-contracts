require("dotenv/config");
const {usePlugin, task} = require("@nomiclabs/buidler/config");

usePlugin("@nomiclabs/buidler-ethers");
usePlugin("@nomiclabs/buidler-web3");
usePlugin("@nomiclabs/buidler-truffle5");
usePlugin("buidler-deploy");

// This is a sample Buidler task. To learn how to create your own go to
// https://buidler.dev/guides/create-task.html
task("accounts", "Prints the list of accounts", async (_, {ethers}) => {
  const accounts = await ethers.getSigners();

  for (const account of accounts) {
    console.log(await account.getAddress());
  }
});

// You have to export an object to set up your config
// This object can have the following optional entries:
// defaultNetwork, networks, solc, and paths.
// Go to https://buidler.dev/config/ to learn more
module.exports = {
  // This is a sample solc configuration that specifies which version of solc to use
  solc: {
    version: "0.4.24",
    optimizer: {
      enabled: true,
      runs: 200,
    },
  },
  paths: {
    sources: "./contracts/0.4.x",
  },
};
