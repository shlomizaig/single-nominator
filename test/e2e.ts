import { waitForContractToBeDeployed, sleep, initWallet, initDeployKey } from "./helpers";
import { SingleNominator } from "../contracts-ts/single-nominator";
import { Address, CellMessage, CommonMessageInfo, InternalMessage, TonClient, WalletContract, toNano, StateInit, beginCell, fromNano, Cell, parseTransaction} from "ton";

import {waitForSeqno, compileFuncToB64} from "./helpers";
import { expect } from "chai";
import {Buffer} from "buffer";

const elector = Address.parse("Ef8zMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM0vF");

// const client = new TonClient({ endpoint: "https://testnet.toncenter.com/api/v2/jsonRPC", apiKey: "0b9c288987a40a10ac53c277fe276fd350d217d0a97858a093c796a5b09f39f6"});
const client = new TonClient({ endpoint: process.env.TON_ENDPOINT || "https://sandbox.tonhubapi.com/jsonRPC"});
const BLOCK_TIME = 10000;
const NOMINATOR_MIN_TON = 3;
const DEPLOYER_MIN_TON = 6;
const VALIDATOR_INDEX = 0;

const NEW_STAKE = 0x4e73744b;
const RECOVER_STAKE = 0x47657424;

const WITHDRAW = 0x1000;
const CHANGE_VALIDATOR_ADDRESS = 0x1001;
const SEND_RAW_MSG = 0x7702;
const UPGRADE = 0x9903;

const WRONG_NOMINATOR_WC = 0x2000;
const WRONG_QUERY_ID = 0x2001;
const WRONG_SET_CODE = 0x2002;
const WRONG_VALIDIATOR_WC = 0x2003;
const INSUFFICIENT_BALANCE = 0x2004;
const INSUFFICIENT_ELECTOR_FEE = 0x2005;

const CELL_UNDERFLOW = 9;

const STAKE_AMOUNT = 1.2345;
const VALIDATOR_MSG_VALUE = 1.0

function buildMessage(op: number | null, query_id: number, eitherBit = false, amount = 0) {
  if (op == null) return beginCell().endCell();

  let cell = beginCell()
  				.storeUint(op, 32)
  				.storeUint(query_id, 64)
  				.storeCoins(toNano(amount.toFixed(2)))
				.storeUint(0, 256) // validator_pubkey
				.storeUint(0, 32) // stake_at
				.storeUint(0, 32) // max_factor
				.storeUint(0, 256) // adnl_addr

  if (eitherBit) {
	  cell.storeRef(beginCell().storeUint(0, 256).endCell()) // signature
  }

  return cell.endCell();
}

function newStakeMsg(query_id: number) {

  return beginCell()
  				.storeUint(NEW_STAKE, 32)
  				.storeUint(query_id, 64)
  				.storeCoins(toNano(STAKE_AMOUNT.toFixed(2)))
				.storeUint(0, 256) // validator_pubkey
				.storeUint(0, 32) // stake_at
				.storeUint(0, 32) // max_factor
				.storeUint(0, 256) // adnl_addr
				.storeRef(beginCell().storeUint(0, 256).endCell()) // signature
		.endCell();
}

function partialNewStakeMsg(query_id: number) {

  return beginCell()
  				.storeUint(NEW_STAKE, 32)
  				.storeUint(query_id, 64)
  				.storeCoins(toNano(STAKE_AMOUNT.toFixed(2)))
				.storeUint(0, 256) // validator_pubkey
				.storeUint(0, 32) // stake_at
				.storeUint(0, 32) // max_factor
				.storeUint(0, 256) // adnl_addr
		.endCell();
}

function recoverStakeMsg(query_id: number) {

  return beginCell()
  				.storeUint(RECOVER_STAKE, 32)
  				.storeUint(query_id, 64)
		.endCell();
}

function parseTxDetails(data: any) {
    const currentContract = data["inMessage"]["destination"];
    let boc = Cell.fromBoc(Buffer.from(data.data, "base64"));
    const wc = Address.parse(currentContract.toString()).workChain;
    return parseTransaction(wc, boc[0].beginParse());
}

async function deployNominator(
  client: TonClient,
  walletContract: WalletContract,
  owner: Address,
  validator: Address,
  privateKey: Buffer
) {

  const contract = await SingleNominator.create({owner, validator});

  if (await client.isContractDeployed(contract.address)) {
    console.log(`contract: ${contract.address.toFriendly()} already Deployed`);
    return contract;
  }

  const seqno = await walletContract.getSeqNo();
  const transfer = await walletContract.createTransfer({
    secretKey: privateKey,
    seqno: seqno,
    sendMode: 1 + 2,
    order: new InternalMessage({
      to: contract.address,
      value: toNano(NOMINATOR_MIN_TON * 2),
      bounce: false,
      body: new CommonMessageInfo({
        stateInit: new StateInit({ data: contract.source.initialData, code: contract.source.initialCode }),
        body: null,
      }),
    }),
  });

  await client.sendExternalMessage(walletContract, transfer);
  await waitForContractToBeDeployed(client, contract.address);
  console.log(`- Deploy transaction sent successfully to -> ${contract.address.toFriendly()} [seqno:${seqno}]`);
  await sleep(BLOCK_TIME);
  return contract;
}

async function transferFunds(
  client: TonClient,
  walletContract: WalletContract,
  privateKey: Buffer,
  contract: SingleNominator | WalletContract,
  amount = NOMINATOR_MIN_TON * 2
) {

  const seqno = await walletContract.getSeqNo();
  const transfer = await walletContract.createTransfer({
    secretKey: privateKey,
    seqno: seqno,
    sendMode: 1 + 2,
    order: new InternalMessage({
      to: contract.address,
      value: toNano(amount),
      bounce: false,
      body: new CommonMessageInfo(),
    }),
  });

  await client.sendExternalMessage(walletContract, transfer);
  await waitForSeqno(walletContract, seqno);
}

async function sendTxToNominator(
  client: TonClient,
  walletContract: WalletContract,
  walletPrivateKey: Buffer,
  nominatorContract: SingleNominator,
  bounce: boolean,
  either: boolean = false,
  opcode: number | null = -1,
  value: number = 0,
  mode = 0,
  query_id: number = 1,
  payload: any = null
) {
  let seqno = await walletContract.getSeqNo();
  console.log(`send message to nominator with payload: ${buildMessage(opcode, query_id, either, value).toString()}`);

  const transfer = await walletContract.createTransfer({
    secretKey: walletPrivateKey,
    seqno: seqno,
    sendMode: mode,
    order: new InternalMessage({
      to: nominatorContract.address,
      value: toNano(.5),
      bounce,
      body: new CommonMessageInfo({
        body: new CellMessage(payload ? payload: buildMessage(opcode, query_id, either, value)),
      }),
    }),
  });

  try {
    await client.sendExternalMessage(walletContract, transfer);
  } catch (e) {
    return false;
  }

  console.log(`- transaction sent successfully to nominator at -> ${nominatorContract.address.toFriendly()} [wallet seqno:${seqno}]`);
  await sleep(BLOCK_TIME);
  return true;
}

async function _sendTxToNominator(
  validatorWallet: WalletContract,
  validatorPrivateKey: Buffer,
  nominatorAddress: Address,
  msg_value: number,
  payload: Cell
) {
  let seqno = await validatorWallet.getSeqNo();
  console.log(`send message to nominator with payload: ${payload.toString()}`);

  const transfer = await validatorWallet.createTransfer({
    secretKey: validatorPrivateKey,
    seqno: seqno,
    sendMode: 1 + 2,
    order: new InternalMessage({
      to: nominatorAddress,
      value: toNano(msg_value),
      bounce: true,
      body: new CommonMessageInfo({
        body: new CellMessage(payload)
	  }),
    }),
  });

  try {
    await client.sendExternalMessage(validatorWallet, transfer);
  } catch (e) {
    return false;
  }

  console.log(`- transaction sent successfully to nominator at -> ${nominatorAddress.toFriendly()} [wallet seqno:${seqno}]`);
  await sleep(BLOCK_TIME);
  return true;
}

describe("e2e test suite", () => {
  let balance: number;
  let newBalance: number;
  let res: any;
  let nominatorContract: SingleNominator;
  let deployWallet: WalletContract;
  let owner: WalletContract;
  let validator: WalletContract;
  let otherWalletContract: WalletContract;
  let deployWalletKey: any;
  let validatorWalletKey: any;
  let otherWalletKey: any;
  let lastTxs: any;
  let payload: Cell;
  let expected_owner;

  before(async () => {
    deployWalletKey = await initDeployKey("");
    res = await initWallet(client, deployWalletKey.publicKey);
    owner = deployWallet = res.wallet;

    console.log(`deployer contract address: ${deployWallet.address.toFriendly()}`);
    console.log(`https://tonsandbox.com/explorer/address/${deployWallet.address.toFriendly()}`);

    balance = parseFloat(fromNano((await client.getBalance(deployWallet.address)).toNumber()));
    if (balance < DEPLOYER_MIN_TON) {
      throw `Deploy wallet balance is too small (${balance}), please send at least ${DEPLOYER_MIN_TON} coins to ${deployWallet.address.toFriendly()}`;
    }

    validatorWalletKey = await initDeployKey(VALIDATOR_INDEX.toString());
    res = await initWallet(client, validatorWalletKey.publicKey, -1);
    validator = res.wallet;
    console.log(`validator contract address: ${validator.address.toFriendly()}`);
    console.log(`https://tonsandbox.com/explorer/address/${validator.address.toFriendly()}`);

    otherWalletKey = await initDeployKey("-1");
    res = await initWallet(client, otherWalletKey.publicKey, -1);
    otherWalletContract = res.wallet;
    console.log(`other wallet contract address: ${otherWalletContract.address.toFriendly()}`);
    console.log(`https://tonsandbox.com/explorer/address/${otherWalletContract.address.toFriendly()}`);

    nominatorContract = await deployNominator(client, deployWallet, owner.address, validator.address, deployWalletKey.secretKey);
    console.log(`nominator contract address: ${nominatorContract.address.toFriendly()}`);
    console.log(`https://tonsandbox.com/explorer/address/${nominatorContract.address.toFriendly()}`);

    balance = parseFloat(fromNano((await client.getBalance(nominatorContract.address)).toNumber()));
    if (balance < NOMINATOR_MIN_TON) {
      console.log(`Nominator contract balance is too small (${balance}), sending coins to ${nominatorContract.address.toFriendly()}`);
      await transferFunds(client, deployWallet, deployWalletKey.secretKey, nominatorContract);
    }

    balance = parseFloat(fromNano((await client.getBalance(validator.address)).toNumber()));
    if (balance < NOMINATOR_MIN_TON) {
      console.log(`Validator contract balance is too small (${balance}), sending coins to ${validator.address.toFriendly()}`);
      await transferFunds(client, deployWallet, deployWalletKey.secretKey, validator);
    }

    balance = parseFloat(fromNano((await client.getBalance(otherWalletContract.address)).toNumber()));
    if (balance < NOMINATOR_MIN_TON) {
      console.log(`Other wallet contract balance is too small (${balance}), sending coins to ${otherWalletContract.address.toFriendly()}`);
      await transferFunds(client, deployWallet, deployWalletKey.secretKey, otherWalletContract);
    }

  });

  it("send NEW_STAKE with small msg_value should fail (INSUFFICIENT_ELECTOR_FEE)", async () => {
    payload = partialNewStakeMsg(1);
    res = await _sendTxToNominator(validator, validatorWalletKey.secretKey, nominatorContract.address, 0.1, payload);
    await sleep(BLOCK_TIME);

	res = await client.getTransactions(nominatorContract.address, {limit: 1});
    res = parseTxDetails(res[0]);
  	expect(res.description.computePhase.exitCode).to.eq(INSUFFICIENT_ELECTOR_FEE);
    expect(res.time).closeTo(Date.now() / 1000, 30);
  });

  it("send NEW_STAKE with query_id=0 should fail (WRONG_QUERY_ID)", async () => {
    payload = partialNewStakeMsg(0);
    res = await _sendTxToNominator(validator, validatorWalletKey.secretKey, nominatorContract.address, VALIDATOR_MSG_VALUE, payload);
    await sleep(BLOCK_TIME);

	res = await client.getTransactions(nominatorContract.address, {limit: 1});
    res = parseTxDetails(res[0]);
  	expect(res.description.computePhase.exitCode).to.eq(WRONG_QUERY_ID);
    expect(res.time).closeTo(Date.now() / 1000, 30);
  });

  it("send NEW_STAKE with partial message should fail (cell underflow)", async () => {
    payload = partialNewStakeMsg(1);
    res = await _sendTxToNominator(validator, validatorWalletKey.secretKey, nominatorContract.address, VALIDATOR_MSG_VALUE, payload);
    await sleep(BLOCK_TIME);

	res = await client.getTransactions(nominatorContract.address, {limit: 1});
    res = parseTxDetails(res[0]);
  	expect(res.description.computePhase.exitCode).to.eq(CELL_UNDERFLOW);
    expect(res.time).closeTo(Date.now() / 1000, 30);
  });

  it("send NEW_STAKE with full message should be bounced from elector", async () => {
    payload = newStakeMsg(1);
    res = await _sendTxToNominator(validator, validatorWalletKey.secretKey, nominatorContract.address, VALIDATOR_MSG_VALUE, payload);
    await sleep(BLOCK_TIME);

	res = await client.getTransactions(nominatorContract.address, {limit: 2});
    res = parseTxDetails(res[0]);
  	expect(res.inMessage.info.bounced).to.eq(true);
  	expect(res.inMessage.info.src.toFriendly()).to.eq(elector.toFriendly());
  	expect(Number(fromNano(res.inMessage.info.value.coins))).closeTo(STAKE_AMOUNT + VALIDATOR_MSG_VALUE, 0.3);
    expect(res.time).closeTo(Date.now() / 1000, 30);
  });

  it.only("send RECOVER_STAKE with full message should be bounced from elector", async () => {
    payload = recoverStakeMsg(1);
    res = await _sendTxToNominator(validator, validatorWalletKey.secretKey, nominatorContract.address, VALIDATOR_MSG_VALUE, payload);
    await sleep(BLOCK_TIME);

	res = await client.getTransactions(nominatorContract.address, {limit: 2});
    res = parseTxDetails(res[0]);
  	expect(res.inMessage.info.bounced).to.eq(true);
  	expect(res.inMessage.info.src.toFriendly()).to.eq(elector.toFriendly());
  	expect(Number(fromNano(res.inMessage.info.value.coins))).closeTo(STAKE_AMOUNT + VALIDATOR_MSG_VALUE, 0.3);
    expect(res.time).closeTo(Date.now() / 1000, 30);
  });

  it("send RECOVER_STAKE", async () => {
  	lastTxs = await client.getTransactions(nominatorContract.address, {limit: 5});
    res = await sendTxToNominator(client, validator, validatorWalletKey.secretKey, nominatorContract, true, false, RECOVER_STAKE, 0, 0);
    expect(res).to.eq(true);
    await sleep(BLOCK_TIME);
    newBalance = parseFloat(fromNano((await client.getBalance(nominatorContract.address)).toNumber()));
    expect(newBalance > balance).to.eq(true);
  	res = await client.getTransactions(nominatorContract.address, {limit: 5});
    expect(res[2].inMessage.createdLt == lastTxs[0].inMessage.createdLt).to.eq(true);
    expect(res[0].outMessages.length).to.eq(0);
    expect(res[1].outMessages.length).to.eq(1);
  });

  it("send wrong opcode", async () => {
  	lastTxs = await client.getTransactions(nominatorContract.address, {limit: 5});
    await sendTxToNominator(client, validator, validatorWalletKey.secretKey, nominatorContract, true, false, 0xBEEF, 0, 0);
    await sleep(BLOCK_TIME);
  	res = await client.getTransactions(nominatorContract.address, {limit: 5});
    expect(res[1].createdLt).to.eq(lastTxs[0].createdLt);
    // TODO: improve expect
  });

  it("send WITHDRAW from owner", async () => {
    balance = parseFloat(fromNano((await client.getBalance(nominatorContract.address)).toNumber())) - 0.5;
    res = await sendTxToNominator(client, owner, deployWalletKey.secretKey, nominatorContract, true, false, WITHDRAW, balance, 0);
    expect(res).to.eq(true);
    await sleep(BLOCK_TIME);
    newBalance = parseFloat(fromNano((await client.getBalance(nominatorContract.address)).toNumber()));
    expect(newBalance).closeTo(0.5, 0.25);
  });

  it("send coins to nominator", async () => {
    balance = parseFloat(fromNano((await client.getBalance(nominatorContract.address)).toNumber()));
    await transferFunds(client, deployWallet, deployWalletKey.secretKey, nominatorContract, NOMINATOR_MIN_TON * 2);
    newBalance = parseFloat(fromNano((await client.getBalance(nominatorContract.address)).toNumber()));
    expect(newBalance).to.closeTo(balance + NOMINATOR_MIN_TON * 2, 0.5);
  });

  it("send WITHDRAW from validator should fail", async () => {
    balance = parseFloat(fromNano((await client.getBalance(nominatorContract.address)).toNumber())) - 0.5;
    res = await sendTxToNominator(client, validator, validatorWalletKey.secretKey, nominatorContract, true, false, WITHDRAW, balance, 0);
    expect(res).to.eq(true);
    await sleep(BLOCK_TIME);
    newBalance = parseFloat(fromNano((await client.getBalance(nominatorContract.address)).toNumber()));
    expect(newBalance).closeTo(balance + 0.5, 0.75);
  });

  it("send WITHDRAW from other account should fail", async () => {
    balance = parseFloat(fromNano((await client.getBalance(nominatorContract.address)).toNumber())) - 0.5;
    res = await sendTxToNominator(client, otherWalletContract, otherWalletKey.secretKey, nominatorContract, true, false, WITHDRAW, balance, 0);
    expect(res).to.eq(true);
    await sleep(BLOCK_TIME);
    newBalance = parseFloat(fromNano((await client.getBalance(nominatorContract.address)).toNumber()));
    expect(newBalance).closeTo(balance + 0.5, 0.75);
  });

  it("change validator from owner", async () => {
	res = await client.callGetMethod(nominatorContract.address, 'get_roles');
    let validator_addr_before_change = bytesToAddress(res.stack[1][1].bytes);
    expect(validator_addr_before_change.toFriendly()).to.eq(validator.address.toFriendly());

  	payload = beginCell().storeUint(CHANGE_VALIDATOR_ADDRESS, 32)
  	.storeUint(1, 64).storeAddress(otherWalletContract.address).endCell();
    res = await sendTxToNominator(client, owner, deployWalletKey.secretKey, nominatorContract, true, false, CHANGE_VALIDATOR_ADDRESS, balance, 0, 1, payload);
    expect(res).to.eq(true);
    await sleep(BLOCK_TIME);
	res = await client.callGetMethod(nominatorContract.address, 'get_roles');
    let validator_addr_after_change = bytesToAddress(res.stack[1][1].bytes);
    expect(validator_addr_after_change.toFriendly()).to.eq(otherWalletContract.address.toFriendly());

  	payload = beginCell().storeUint(CHANGE_VALIDATOR_ADDRESS, 32)
  	.storeUint(1, 64).storeAddress(validator.address).endCell();
    res = await sendTxToNominator(client, owner, deployWalletKey.secretKey, nominatorContract, true, false, CHANGE_VALIDATOR_ADDRESS, balance, 0, 1, payload);
    expect(res).to.eq(true);
    await sleep(BLOCK_TIME);
	res = await client.callGetMethod(nominatorContract.address, 'get_roles');
    let new_validator_addr = bytesToAddress(res.stack[1][1].bytes);
    expect(new_validator_addr.toFriendly()).to.eq(validator.address.toFriendly());
  });

  it("change validator from validator should fail", async () => {
	res = await client.callGetMethod(nominatorContract.address, 'get_roles');
    let validator_addr_before_change = bytesToAddress(res.stack[1][1].bytes);
    expect(validator_addr_before_change.toFriendly()).to.eq(validator.address.toFriendly());

  	payload = beginCell().storeUint(CHANGE_VALIDATOR_ADDRESS, 32)
  	.storeUint(1, 64).storeAddress(otherWalletContract.address).endCell();
    res = await sendTxToNominator(client, validator, validatorWalletKey.secretKey, nominatorContract, true, false, CHANGE_VALIDATOR_ADDRESS, balance, 0, 1, payload);
    expect(res).to.eq(true);
    await sleep(BLOCK_TIME);
	res = await client.callGetMethod(nominatorContract.address, 'get_roles');
    let validator_addr_after_change = bytesToAddress(res.stack[1][1].bytes);
    expect(validator_addr_after_change.toFriendly()).to.eq(validator.address.toFriendly());
  });

  it("send NEW_STAKE with mode 128 using SEND_RAW_MSG from owner", async () => {

  	lastTxs = await client.getTransactions(nominatorContract.address, {limit: 5});

    balance = parseFloat(fromNano((await client.getBalance(nominatorContract.address)).toNumber()));

	let mode = 128;
  	payload = beginCell().storeUint(SEND_RAW_MSG, 32).storeUint(1, 64)
  	.storeUint(mode, 8).storeRef(
		beginCell().storeUint(0x18, 6).storeAddress(elector).storeCoins(0)
		.storeUint(0, 1 + 4 + 4 + 64 + 32 + 1 + 1)
		.storeUint(NEW_STAKE, 32).storeUint(1, 64).endCell()
  	)
  	.endCell();

    res = await sendTxToNominator(client, owner, deployWalletKey.secretKey, nominatorContract, true, false, SEND_RAW_MSG, balance, 0, 1, payload);
    await sleep(BLOCK_TIME);

  	res = await client.getTransactions(nominatorContract.address, {limit: 5});

    newBalance = parseFloat(fromNano((await client.getBalance(nominatorContract.address)).toNumber()));
    expect(newBalance).closeTo(balance, 1);
	expect(res[2].createdLt).to.eq(lastTxs[0].createdLt);
	expect(Number(fromNano(res[0].inMessage.value))).to.closeTo(balance, 1);
  });

  it("send WITHDRAW with mode 128 using SEND_RAW_MSG from owner", async () => {

	let mode = 128;
  	payload = beginCell().storeUint(SEND_RAW_MSG, 32).storeUint(1, 64)
  	.storeUint(mode, 8).storeRef(
		beginCell().storeUint(0x18, 6).storeAddress(owner.address).storeCoins(0)
		.storeUint(0, 1 + 4 + 4 + 64 + 32 + 1 + 1)
		.storeUint(0x101, 32).storeUint(1, 64).endCell()
  	)
  	.endCell();

    res = await sendTxToNominator(client, owner, deployWalletKey.secretKey, nominatorContract, true, false, SEND_RAW_MSG, 0, 0, 1, payload);
    await sleep(BLOCK_TIME);

    newBalance = parseFloat(fromNano((await client.getBalance(nominatorContract.address)).toNumber()));
    expect(newBalance).eq(0);
  });

  it("send upgrade from owner", async () => {

	res = await client.callGetMethod(nominatorContract.address, 'get_roles');
	expected_owner = bytesToAddress(res.stack[0][1].bytes);
    expect(expected_owner.toFriendly()).to.eq(owner.address.toFriendly());

    balance = parseFloat(fromNano((await client.getBalance(nominatorContract.address)).toNumber()));

	let codeB64: string = compileFuncToB64(["contracts/imports/stdlib.fc", "contracts/test-upgrade.fc"]);
	let code = Cell.fromBoc(codeB64);

  	payload = beginCell().storeUint(UPGRADE, 32).storeUint(1, 64)
  	.storeRef(code[0]).endCell();

    res = await sendTxToNominator(client, owner, deployWalletKey.secretKey, nominatorContract, true, false, SEND_RAW_MSG, balance, 0, 1, payload);
    await sleep(3 * BLOCK_TIME);

	res = await client.callGetMethod(nominatorContract.address, 'magic');
    expect(res.stack[0][1]).to.eq('0xcafe');

	codeB64 = compileFuncToB64(["contracts/imports/stdlib.fc", "contracts/single-nominator.fc"]);
	code = Cell.fromBoc(codeB64);

  	payload = beginCell().storeUint(UPGRADE, 32).storeUint(1, 64)
  	.storeRef(code[0]).endCell();

    res = await sendTxToNominator(client, owner, deployWalletKey.secretKey, nominatorContract, true, false, SEND_RAW_MSG, balance, 0, 1, payload);
    await sleep(3 * BLOCK_TIME);

	res = await client.callGetMethod(nominatorContract.address, 'get_roles');
    expected_owner = bytesToAddress(res.stack[0][1].bytes);
    expect(expected_owner.toFriendly()).to.eq(owner.address.toFriendly());
  });

});


function bytesToAddress(bufferB64: string) {
    const buff = Buffer.from(bufferB64, "base64");
    let c2 = Cell.fromBoc(buff);
    return c2[0].beginParse().readAddress() as Address;
}
