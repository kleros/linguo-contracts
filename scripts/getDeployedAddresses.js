// jq -s '[.[] | . as {address: $address, linkedData: { $languagePair }} | {key: $languagePair, value: $address}] | from_entries' deployments/kovan/*.json

const {deployments} = require("@nomiclabs/buidler");

async function main() {
  const allDeployments = await deployments.all();
  const deployedAddresses = Object.values(allDeployments).reduce(
    (acc, {address, linkedData}) =>
      Object.assign(
        acc,
        Object.assign(acc, {
          [linkedData.languagePair]: address,
        })
      ),
    {}
  );
  console.log(JSON.stringify(deployedAddresses, null, 2));
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.log(err);
    process.exit(1);
  });
