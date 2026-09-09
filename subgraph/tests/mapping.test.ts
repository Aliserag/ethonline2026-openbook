import { describe, test, assert, clearStore, newMockEvent } from "matchstick-as/assembly/index";
import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import { JobFunded } from "../generated/ERC8183/ERC8183";
import { WithdrawalExecuted } from "../generated/PolicyWallet/PolicyWallet";
import {
  handleQueryPaid,
  handleCostPaid,
} from "../src/mapping";

function createJobFundedEvent(
  jobId: BigInt,
  client: Address,
  amount: BigInt,
  blockNumber: BigInt,
): JobFunded {
  let event = changetype<JobFunded>(newMockEvent());
  event.parameters = new Array();
  event.parameters.push(
    new ethereum.EventParam("jobId", ethereum.Value.fromUnsignedBigInt(jobId)),
  );
  event.parameters.push(
    new ethereum.EventParam("client", ethereum.Value.fromAddress(client)),
  );
  event.parameters.push(
    new ethereum.EventParam("amount", ethereum.Value.fromUnsignedBigInt(amount)),
  );
  event.block.number = blockNumber;
  event.block.timestamp = BigInt.fromI32(1_700_000_000);
  event.transaction.hash = Bytes.fromHexString(
    "0xaaaa00000000000000000000000000000000000000000000000000000000000001",
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
  event.parameters.push(
    new ethereum.EventParam("to", ethereum.Value.fromAddress(to)),
  );
  event.parameters.push(
    new ethereum.EventParam("amount", ethereum.Value.fromUnsignedBigInt(amount)),
  );
  event.block.number = blockNumber;
  event.block.timestamp = BigInt.fromI32(1_700_000_000);
  event.transaction.hash = Bytes.fromHexString(
    "0xbbbb00000000000000000000000000000000000000000000000000000000000002",
  );
  return event;
}

describe("handleQueryPaid", () => {

  test("creates QueryPaid entity and buckets revenue into DailyPnL", () => {
    let client = Address.fromString("0x8BA1f109551bD432803012645Ac136ddd64DBA72");
    // block 21600 belongs to day-1 (21600/21600); 43000 -> day-1 as well
    let event = createJobFundedEvent(
      BigInt.fromI32(7),
      client,
      BigInt.fromString("1000000"), // 1.0 USDC (6-dec)
      BigInt.fromI32(23_000),
    );
    clearStore();
    handleQueryPaid(event);

    // QueryPaid row captured (jobId 7, buyer == client, amount)
    assert.entityCount("QueryPaid", 1);

    // DailyPnL day bucket aggregates revenue, net == revenue
    assert.entityCount("DailyPnL", 1);
    assert.fieldEquals("DailyPnL", "day-1", "revenue", "1000000");
    assert.fieldEquals("DailyPnL", "day-1", "refunds", "0");
    assert.fieldEquals("DailyPnL", "day-1", "costs", "0");
    assert.fieldEquals("DailyPnL", "day-1", "net", "1000000");
  });

  test("buckets two QueryPaid events in the same day and different days", () => {
    let client = Address.fromString("0x8BA1f109551bD432803012645Ac136ddd64DBA72");
    clearStore();
    handleQueryPaid(
      createJobFundedEvent(BigInt.fromI32(1), client, BigInt.fromString("500000"), BigInt.fromI32(21_600)),
    );
    handleQueryPaid(
      createJobFundedEvent(BigInt.fromI32(2), client, BigInt.fromString("250000"), BigInt.fromI32(22_000)),
    );
    // both land in day-1 -> 750000 revenue
    assert.fieldEquals("DailyPnL", "day-1", "revenue", "750000");
    assert.entityCount("DailyPnL", 1);

    // a later day (43200 -> day-2)
    handleQueryPaid(
      createJobFundedEvent(BigInt.fromI32(3), client, BigInt.fromString("100000"), BigInt.fromI32(43_300)),
    );
    assert.entityCount("DailyPnL", 2);
    assert.fieldEquals("DailyPnL", "day-2", "revenue", "100000");
    assert.fieldEquals("DailyPnL", "day-1", "revenue", "750000");
  });
});

describe("handleCostPaid", () => {

  test("records CostPaid and deducts costs from day net", () => {
    let to = Address.fromString("0x00000000000000000000000000000000000000DE");
    let event = createWithdrawalExecutedEvent(to, BigInt.fromString("300000"), BigInt.fromI32(21_700));
    clearStore();
    handleCostPaid(event);

    assert.entityCount("CostPaid", 1);
    assert.entityCount("DailyPnL", 1);
    assert.fieldEquals("DailyPnL", "day-1", "costs", "300000");
    assert.fieldEquals("DailyPnL", "day-1", "net", "-300000");
  });
});
