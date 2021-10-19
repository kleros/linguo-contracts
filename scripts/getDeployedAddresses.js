// jq -s '[.[] | . as {address: $address, linkedData: { $languagePair }} | {key: $languagePair, value: $address}] | from_entries' deployments/kovan/*.json

const { deployments } = require("hardhat");

async function main() {
  const allDeployments = await deployments.all();
  const deployedAddresses = Object.values(allDeployments).reduce(
    (acc, { address, linkedData }) =>
      Object.assign(
        acc,
        Object.assign(acc, {
          [linkedData.languagePair]: [address],
        })
      ),
    {}
  );
  console.log(JSON.stringify(deployedAddresses));
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.log(err);
    process.exit(1);
  });
