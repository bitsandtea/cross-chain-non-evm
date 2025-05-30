import Test

access(all) let account = Test.createAccount()

access(all) fun testContract() {
    let err = Test.deployContract(
        name: "FooToken",
        path: "../contracts/FooToken.cdc",
        arguments: [],
    )

    Test.expect(err, Test.beNil())
}