import { describe, test, assert, clearStore, newMockEvent } from "matchstick-as/assembly/index";
import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import { JobCreated, JobFunded, PaymentReleased, Refunded } from "../generated/ERC8183/ERC8183";
import { WithdrawalExecuted, PolicySet } from "../generated/PolicyWallet/PolicyWallet";
import {
  handleJobCreated,
  handleQueryPaid,
  handleSettled,
  handleRefund,
  handleCostPaid,
  handlePolicySet,
  SELLER,
} from "../src/mapping";

const CLIENT = "0x8BA1f109551bD432803012645Ac136ddd64DBA72";
// "ours" = the provider the mapping books for (SELLER placeholder; the deploy
// script substitutes the real operator address — tests follow the constant).
const PROVIDER = SELLER;
// a foreign provider on the SHARED reference contract (another ETHOnline agent).
// Must NEVER equal the deploy-time SELLER substitution — the real OpenBook
// operator address once sat here and silently became "ours" the moment the
// funded deploy baked it in, breaking this test at review time.
const FOREIGN = "0x1111111111111111111111111111111111111111";

function createJobCreatedEvent(
  jobId: BigInt,
  client: Address,
  provider: Address,
  expiredAt: BigInt,
  blockNumber: BigInt,
): JobCreated {
  let event = changetype<JobCreated>(newMockEvent());
  event.parameters = new Array();
  event.parameters.push(
    new ethereum.EventParam("jobId", ethereum.Value.fromUnsignedBigInt(jobId)),
  );
  event.parameters.push(new ethereum.EventParam("client", ethereum.Value.fromAddress(client)));
  event.parameters.push(new ethereum.EventParam("provider", ethereum.Value.fromAddress(provider)));
  event.parameters.push(
    new ethereum.EventParam("evaluator", ethereum.Value.fromAddress(Address.zero())),
  );
  event.parameters.push(new ethereum.EventParam("expiredAt", ethereum.Value.fromUnsignedBigInt(expiredAt)));
  event.parameters.push(new ethereum.EventParam("hook", ethereum.Value.fromAddress(Address.zero())));
  event.block.number = blockNumber;
  event.block.timestamp = BigInt.fromI32(1_700_000_000);
  event.transaction.hash = Bytes.fromHexString(
    "0xaaaa00000000000000000000000000000000000000000000000000000000000001",
  );
  return event;
}

function createJobFundedEvent(
  jobId: BigInt,
  client: Address,
  amount: BigInt,
  blockNumber: BigInt,
): JobFunded {
  let event = changetype<JobFunded>(newMockEvent());
  event.parameters = new Array();
  event.parameters.push(new ethereum.EventParam("jobId", ethereum.Value.fromUnsignedBigInt(jobId)));
  event.parameters.push(new ethereum.EventParam("client", ethereum.Value.fromAddress(client)));
  event.parameters.push(new ethereum.EventParam("amount", ethereum.Value.fromUnsignedBigInt(amount)));
  event.block.number = blockNumber;
  event.block.timestamp = BigInt.fromI32(1_700_000_000);
  event.transaction.hash = Bytes.fromHexString(
    "0xbbbb00000000000000000000000000000000000000000000000000000000000002",
  );
  return event;
}

function createPaymentReleasedEvent(
  jobId: BigInt,
  provider: Address,
  amount: BigInt,
  blockNumber: BigInt,
): PaymentReleased {
  let event = changetype<PaymentReleased>(newMockEvent());
  event.parameters = new Array();
  event.parameters.push(new ethereum.EventParam("jobId", ethereum.Value.fromUnsignedBigInt(jobId)));
  event.parameters.push(new ethereum.EventParam("provider", ethereum.Value.fromAddress(provider)));
  event.parameters.push(new ethereum.EventParam("amount", ethereum.Value.fromUnsignedBigInt(amount)));
  event.block.number = blockNumber;
  event.block.timestamp = BigInt.fromI32(1_700_000_000);
  event.transaction.hash = Bytes.fromHexString(
    "0xcccc00000000000000000000000000000000000000000000000000000000000003",
  );
  return event;
}

function createRefundedEvent(
  jobId: BigInt,
  client: Address,
  amount: BigInt,
  blockNumber: BigInt,
): Refunded {
  let event = changetype<Refunded>(newMockEvent());
  event.parameters = new Array();
  event.parameters.push(new ethereum.EventParam("jobId", ethereum.Value.fromUnsignedBigInt(jobId)));
  event.parameters.push(new ethereum.EventParam("client", ethereum.Value.fromAddress(client)));
  event.parameters.push(new ethereum.EventParam("amount", ethereum.Value.fromUnsignedBigInt(amount)));
  event.block.number = blockNumber;
  event.block.timestamp = BigInt.fromI32(1_700_000_000);
  event.transaction.hash = Bytes.fromHexString(
    "0xddde00000000000000000000000000000000000000000000000000000000000000",
  );
  return event;
}

function createWithdrawalExecutedEvent(
  to: Address,
  amount: BigInt,
  blockNumber: BigInt,
): WithdrawalExecuted {
  let event = changetype<WithdrawalExecuted>(newMockEvent());
  event.parameters = new Array();
  event.parameters.push(new ethereum.EventParam("to", ethereum.Value.fromAddress(to)));
  event.parameters.push(new ethereum.EventParam("amount", ethereum.Value.fromUnsignedBigInt(amount)));
  event.block.number = blockNumber;
  event.block.timestamp = BigInt.fromI32(1_700_000_000);
  event.transaction.hash = Bytes.fromHexString(
    "0xdddd00000000000000000000000000000000000000000000000000000000000004",
  );
  return event;
}

function createPolicySetEvent(perTxCap: BigInt, dailyCap: BigInt): PolicySet {
  let event = changetype<PolicySet>(newMockEvent());
  event.parameters = new Array();
  event.parameters.push(new ethereum.EventParam("perTxCap", ethereum.Value.fromUnsignedBigInt(perTxCap)));
  event.parameters.push(new ethereum.EventParam("dailyCap", ethereum.Value.fromUnsignedBigInt(dailyCap)));
  event.block.number = BigInt.fromI32(21_700);
  event.block.timestamp = BigInt.fromI32(1_700_000_000);
  event.transaction.hash = Bytes.fromHexString(
    "0xeeee00000000000000000000000000000000000000000000000000000000000005",
  );
  return event;
}

describe("handleJobCreated + handleQueryPaid", () => {
  test("JobCreated stores real seller/deadline; JobFunded adds amount without P&L", () => {
    clearStore();
    let client = Address.fromString(CLIENT);
    let provider = Address.fromString(PROVIDER);

    // JobCreated: seller = provider, deadline = expiredAt, minBlock = creation block
    handleJobCreated(
      createJobCreatedEvent(BigInt.fromI32(7), client, provider, BigInt.fromI32(999_999), BigInt.fromI32(21_500)),
    );
    // JobFunded: amount recorded, but books NO revenue yet (commitment, not earnings)
    handleQueryPaid(
      createJobFundedEvent(BigInt.fromI32(7), client, BigInt.fromString("1000000"), BigInt.fromI32(23_000)),
    );

    assert.entityCount("QueryPaid", 1);
    // Real seller (provider) + deadline (expiredAt); store key = bytes hex of "qp-7"
    assert.fieldEquals("QueryPaid", "0x71702d37", "seller", SELLER.toLowerCase()); // store keeps bytes-hex (lowercase)
    assert.fieldEquals("QueryPaid", "0x71702d37", "buyer", "0x8ba1f109551bd432803012645ac136ddd64dba72");
    assert.fieldEquals("QueryPaid", "0x71702d37", "deadline", "999999");
    assert.fieldEquals("QueryPaid", "0x71702d37", "minBlock", "21500");
    assert.fieldEquals("QueryPaid", "0x71702d37", "amount", "1000000");

    // No DailyPnL written by funding alone
    assert.entityCount("DailyPnL", 0);
  });

  test("funded + settled job books its amount exactly once", () => {
    clearStore();
    let client = Address.fromString(CLIENT);
    let provider = Address.fromString(PROVIDER);

    handleJobCreated(
      createJobCreatedEvent(BigInt.fromI32(1), client, provider, BigInt.fromI32(999_999), BigInt.fromI32(21_500)),
    );
    handleQueryPaid(
      createJobFundedEvent(BigInt.fromI32(1), client, BigInt.fromString("1000000"), BigInt.fromI32(23_000)),
    );
    // Settlement = the single revenue event
    handleSettled(
      createPaymentReleasedEvent(BigInt.fromI32(1), provider, BigInt.fromString("1000000"), BigInt.fromI32(23_100)),
    );

    // day-1 (23100/21600): revenue == 1000000 exactly once, not 2000000.
    assert.fieldEquals("DailyPnL", "day-1", "startedAt", "1700000000"); // UI day label
    assert.fieldEquals("DailyPnL", "day-1", "revenue", "1000000");
    assert.fieldEquals("DailyPnL", "day-1", "net", "1000000");
    assert.entityCount("DailyPnL", 1);
  });

  test("foreign-provider JobFunded/Settled pair books NO P&L (provider-scoped)", () => {
    clearStore();
    let client = Address.fromString(CLIENT);
    let foreign = Address.fromString(FOREIGN);

    // foreign JobCreated → no QueryPaid row (skipped)
    handleJobCreated(
      createJobCreatedEvent(BigInt.fromI32(9), client, foreign, BigInt.fromI32(999_999), BigInt.fromI32(21_500)),
    );
    assert.entityCount("QueryPaid", 0);
    // foreign funding finds no scoped row → dropped, not invented
    handleQueryPaid(
      createJobFundedEvent(BigInt.fromI32(9), client, BigInt.fromString("1000000"), BigInt.fromI32(23_000)),
    );
    assert.entityCount("QueryPaid", 0);
    // foreign settlement → NO revenue on DailyPnL
    handleSettled(
      createPaymentReleasedEvent(BigInt.fromI32(9), foreign, BigInt.fromString("1000000"), BigInt.fromI32(23_100)),
    );
    assert.entityCount("DailyPnL", 0);
    assert.entityCount("Settled", 0);
  });

  test("own refund books refunds; foreign refund without a scoped job books nothing", () => {
    clearStore();
    let client = Address.fromString(CLIENT);
    let provider = Address.fromString(PROVIDER);
    let foreign = Address.fromString(FOREIGN);

    // ours: JobCreated → Refunded → refunds + negative net, exactly once
    handleJobCreated(
      createJobCreatedEvent(BigInt.fromI32(5), client, provider, BigInt.fromI32(999_999), BigInt.fromI32(21_500)),
    );
    handleRefund(
      createRefundedEvent(BigInt.fromI32(5), client, BigInt.fromString("250000"), BigInt.fromI32(22_000)),
    );
    assert.entityCount("RefundIssued", 1);
    assert.fieldEquals("DailyPnL", "day-1", "refunds", "250000");
    assert.fieldEquals("DailyPnL", "day-1", "net", "-250000");

    // foreign: no scoped job row → the refund books nothing
    clearStore();
    handleRefund(
      createRefundedEvent(BigInt.fromI32(99), client, BigInt.fromString("500000"), BigInt.fromI32(22_000)),
    );
    assert.entityCount("RefundIssued", 0);
    assert.entityCount("DailyPnL", 0);
  });

  test("buckets revenue across days from settlements", () => {
    clearStore();
    let client = Address.fromString(CLIENT);
    let provider = Address.fromString(PROVIDER);

    handleSettled(
      createPaymentReleasedEvent(BigInt.fromI32(1), provider, BigInt.fromString("500000"), BigInt.fromI32(21_600)),
    );
    handleSettled(
      createPaymentReleasedEvent(BigInt.fromI32(2), provider, BigInt.fromString("250000"), BigInt.fromI32(22_000)),
    );
    // both in day-1
    assert.fieldEquals("DailyPnL", "day-1", "revenue", "750000");
    assert.entityCount("DailyPnL", 1);

    // 43300 -> day-2
    handleSettled(
      createPaymentReleasedEvent(BigInt.fromI32(3), provider, BigInt.fromString("100000"), BigInt.fromI32(43_300)),
    );
    assert.entityCount("DailyPnL", 2);
    assert.fieldEquals("DailyPnL", "day-2", "revenue", "100000");
    assert.fieldEquals("DailyPnL", "day-1", "revenue", "750000");
  });
});

describe("handleCostPaid + handlePolicySet", () => {
  test("records CostPaid and deducts costs from day net", () => {
    clearStore();
    let to = Address.fromString("0x00000000000000000000000000000000000000DE");
    handleCostPaid(createWithdrawalExecutedEvent(to, BigInt.fromString("300000"), BigInt.fromI32(21_700)));

    assert.entityCount("CostPaid", 1);
    assert.entityCount("DailyPnL", 1);
    assert.fieldEquals("DailyPnL", "day-1", "costs", "300000");
    assert.fieldEquals("DailyPnL", "day-1", "net", "-300000");
  });

  test("PolicySet records current caps into PolicyConfig", () => {
    clearStore();
    handlePolicySet(createPolicySetEvent(BigInt.fromString("1000000"), BigInt.fromString("10000000")));
    handlePolicySet(createPolicySetEvent(BigInt.fromString("2000000"), BigInt.fromString("20000000")));

    assert.entityCount("PolicyConfig", 1);
    assert.fieldEquals("PolicyConfig", "current", "perTxCap", "2000000");
    assert.fieldEquals("PolicyConfig", "current", "dailyCap", "20000000");
  });
});
