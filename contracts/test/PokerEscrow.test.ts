import { expect } from 'chai';
import hre from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-toolbox-viem/network-helpers';
import { keccak256, parseEther, toHex, getAddress, zeroAddress } from 'viem';

const TIER_PRICES = [
  parseEther('0.0015'),
  parseEther('0.015'),
  parseEther('0.075'),
  parseEther('0.15'),
] as const;
const TIER_CHIPS = [100n, 1_000n, 5_000n, 10_000n] as const;
// Every tier prices a chip identically, so buying and redeeming agree.
const WEI_PER_CHIP = TIER_PRICES[0] / TIER_CHIPS[0];

const TABLE_A = keccak256(toHex('table-a'));
const TABLE_B = keccak256(toHex('table-b'));

async function deployFixture() {
  const [owner, arbiter, alice, bob, carol] = await hre.viem.getWalletClients();
  const escrow = await hre.viem.deployContract('PokerEscrow', [
    arbiter!.account.address,
    [...TIER_PRICES],
    [...TIER_CHIPS],
    WEI_PER_CHIP,
  ]);
  const publicClient = await hre.viem.getPublicClient();
  return { escrow, publicClient, owner: owner!, arbiter: arbiter!, alice: alice!, bob: bob!, carol: carol! };
}

/** Returns a contract handle that sends transactions from `wallet`. */
async function as(escrow: { address: `0x${string}` }, wallet: { account: { address: `0x${string}` } }) {
  return hre.viem.getContractAt('PokerEscrow', escrow.address, { client: { wallet: wallet as never } });
}

describe('PokerEscrow', () => {
  describe('deployment', () => {
    it('stores roles and tier configuration', async () => {
      const { escrow, owner, arbiter } = await loadFixture(deployFixture);
      expect(getAddress(await escrow.read.owner())).to.equal(getAddress(owner.account.address));
      expect(getAddress(await escrow.read.arbiterServer())).to.equal(
        getAddress(arbiter.account.address),
      );
      for (let i = 0; i < 4; i++) {
        const [price, chips] = await escrow.read.quoteTier([i + 1]);
        expect(price).to.equal(TIER_PRICES[i]);
        expect(chips).to.equal(TIER_CHIPS[i]);
      }
      expect(await escrow.read.weiPerChip()).to.equal(WEI_PER_CHIP);
    });

    it('rejects a zero arbiter', async () => {
      await expect(
        hre.viem.deployContract('PokerEscrow', [
          zeroAddress,
          [...TIER_PRICES],
          [...TIER_CHIPS],
          WEI_PER_CHIP,
        ]),
      ).to.be.rejected;
    });
  });

  describe('buyChips', () => {
    it('credits the tier package and tracks the liability', async () => {
      const { escrow, alice } = await loadFixture(deployFixture);
      const aliceEscrow = await as(escrow, alice);

      await aliceEscrow.write.buyChips([2], { value: TIER_PRICES[1] });

      expect(await escrow.read.userChipBalance([alice.account.address])).to.equal(TIER_CHIPS[1]);
      expect(await escrow.read.totalChipsOutstanding()).to.equal(TIER_CHIPS[1]);
    });

    it('emits ChipsPurchased', async () => {
      const { escrow, alice, publicClient } = await loadFixture(deployFixture);
      const aliceEscrow = await as(escrow, alice);
      const hash = await aliceEscrow.write.buyChips([1], { value: TIER_PRICES[0] });
      await publicClient.waitForTransactionReceipt({ hash });

      const events = await escrow.getEvents.ChipsPurchased();
      expect(events).to.have.length(1);
      expect(events[0]!.args.chipsCredited).to.equal(TIER_CHIPS[0]);
      expect(events[0]!.args.packageTier).to.equal(1n);
    });

    it('accumulates across multiple purchases', async () => {
      const { escrow, alice } = await loadFixture(deployFixture);
      const aliceEscrow = await as(escrow, alice);
      await aliceEscrow.write.buyChips([1], { value: TIER_PRICES[0] });
      await aliceEscrow.write.buyChips([3], { value: TIER_PRICES[2] });
      expect(await escrow.read.userChipBalance([alice.account.address])).to.equal(
        TIER_CHIPS[0] + TIER_CHIPS[2],
      );
    });

    it('refunds an overpayment instead of absorbing it', async () => {
      const { escrow, alice, publicClient } = await loadFixture(deployFixture);
      const aliceEscrow = await as(escrow, alice);
      const before = await publicClient.getBalance({ address: alice.account.address });

      const hash = await aliceEscrow.write.buyChips([1], { value: TIER_PRICES[0] * 3n });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      const gas = receipt.gasUsed * receipt.effectiveGasPrice;

      const after = await publicClient.getBalance({ address: alice.account.address });
      expect(before - after - gas).to.equal(TIER_PRICES[0]);
      expect(await publicClient.getBalance({ address: escrow.address })).to.equal(TIER_PRICES[0]);
    });

    it('rejects underpayment and unknown tiers', async () => {
      const { escrow, alice } = await loadFixture(deployFixture);
      const aliceEscrow = await as(escrow, alice);
      await expect(aliceEscrow.write.buyChips([2], { value: TIER_PRICES[0] })).to.be.rejected;
      await expect(aliceEscrow.write.buyChips([5], { value: TIER_PRICES[3] })).to.be.rejected;
      await expect(aliceEscrow.write.buyChips([0], { value: TIER_PRICES[0] })).to.be.rejected;
    });

    it('refuses purchases while paused', async () => {
      const { escrow, owner, alice } = await loadFixture(deployFixture);
      await (await as(escrow, owner)).write.setPaused([true]);
      await expect(
        (await as(escrow, alice)).write.buyChips([1], { value: TIER_PRICES[0] }),
      ).to.be.rejected;
    });
  });

  describe('lockChipsForTable', () => {
    async function funded() {
      const ctx = await loadFixture(deployFixture);
      for (const w of [ctx.alice, ctx.bob, ctx.carol]) {
        await (await as(ctx.escrow, w)).write.buyChips([2], { value: TIER_PRICES[1] });
      }
      return ctx;
    }

    it('moves chips from the balance into the table stake', async () => {
      const { escrow, alice } = await funded();
      await (await as(escrow, alice)).write.lockChipsForTable([TABLE_A, 250n]);

      expect(await escrow.read.userChipBalance([alice.account.address])).to.equal(
        TIER_CHIPS[1] - 250n,
      );
      expect(await escrow.read.tableStake([TABLE_A, alice.account.address])).to.equal(250n);

      const [buyIn, staked, , active, settled, players] = await escrow.read.tableInfo([TABLE_A]);
      expect(buyIn).to.equal(250n);
      expect(staked).to.equal(250n);
      expect(active).to.equal(true);
      expect(settled).to.equal(false);
      expect(players).to.equal(1n);
    });

    it('supports the multi-table batch deploy the arena is built on', async () => {
      const { escrow, alice } = await funded();
      const aliceEscrow = await as(escrow, alice);
      await aliceEscrow.write.lockChipsForTable([TABLE_A, 250n]);
      await aliceEscrow.write.lockChipsForTable([TABLE_B, 100n]);

      expect(await escrow.read.userChipBalance([alice.account.address])).to.equal(
        TIER_CHIPS[1] - 350n,
      );
      expect(await escrow.read.tableStake([TABLE_B, alice.account.address])).to.equal(100n);
    });

    it('locks every entrant to the buy-in set by the first', async () => {
      const { escrow, alice, bob } = await funded();
      await (await as(escrow, alice)).write.lockChipsForTable([TABLE_A, 250n]);
      await expect(
        (await as(escrow, bob)).write.lockChipsForTable([TABLE_A, 300n]),
      ).to.be.rejected;
      await (await as(escrow, bob)).write.lockChipsForTable([TABLE_A, 250n]);

      const [, staked, , , , players] = await escrow.read.tableInfo([TABLE_A]);
      expect(staked).to.equal(500n);
      expect(players).to.equal(2n);
    });

    it('refuses a second seat for the same wallet', async () => {
      const { escrow, alice } = await funded();
      const aliceEscrow = await as(escrow, alice);
      await aliceEscrow.write.lockChipsForTable([TABLE_A, 250n]);
      await expect(aliceEscrow.write.lockChipsForTable([TABLE_A, 250n])).to.be.rejected;
    });

    it('refuses an underfunded buy-in', async () => {
      const { escrow, alice } = await funded();
      await expect(
        (await as(escrow, alice)).write.lockChipsForTable([TABLE_A, TIER_CHIPS[1] + 1n]),
      ).to.be.rejected;
    });
  });

  describe('settlement', () => {
    async function seated() {
      const ctx = await loadFixture(deployFixture);
      for (const w of [ctx.alice, ctx.bob]) {
        await (await as(ctx.escrow, w)).write.buyChips([2], { value: TIER_PRICES[1] });
        await (await as(ctx.escrow, w)).write.lockChipsForTable([TABLE_A, 250n]);
      }
      return ctx;
    }

    it('credits a single winner the whole pot', async () => {
      const { escrow, arbiter, alice } = await seated();
      await (await as(escrow, arbiter)).write.settleTable([TABLE_A, alice.account.address, 500n]);

      expect(await escrow.read.userChipBalance([alice.account.address])).to.equal(
        TIER_CHIPS[1] - 250n + 500n,
      );
      const [, , , active, settled] = await escrow.read.tableInfo([TABLE_A]);
      expect(active).to.equal(false);
      expect(settled).to.equal(true);
    });

    it('credits every seat its final stack', async () => {
      const { escrow, arbiter, alice, bob } = await seated();
      await (await as(escrow, arbiter)).write.settleTableMulti([
        TABLE_A,
        [alice.account.address, bob.account.address],
        [380n, 120n],
      ]);
      expect(await escrow.read.userChipBalance([alice.account.address])).to.equal(
        TIER_CHIPS[1] - 250n + 380n,
      );
      expect(await escrow.read.userChipBalance([bob.account.address])).to.equal(
        TIER_CHIPS[1] - 250n + 120n,
      );
    });

    it('never pays out more than the table staked', async () => {
      const { escrow, arbiter, alice } = await seated();
      await expect(
        (await as(escrow, arbiter)).write.settleTable([TABLE_A, alice.account.address, 501n]),
      ).to.be.rejected;
    });

    it('routes an undistributed remainder to the house', async () => {
      const { escrow, arbiter, owner, alice } = await seated();
      const before = await escrow.read.userChipBalance([owner.account.address]);
      await (await as(escrow, arbiter)).write.settleTable([TABLE_A, alice.account.address, 480n]);
      expect(await escrow.read.userChipBalance([owner.account.address])).to.equal(before + 20n);
    });

    it('conserves chips through a full buy → play → settle cycle', async () => {
      const { escrow, arbiter, alice, bob } = await seated();
      await (await as(escrow, arbiter)).write.settleTableMulti([
        TABLE_A,
        [alice.account.address, bob.account.address],
        [500n, 0n],
      ]);
      const total =
        (await escrow.read.userChipBalance([alice.account.address])) +
        (await escrow.read.userChipBalance([bob.account.address]));
      expect(total).to.equal(TIER_CHIPS[1] * 2n);
      expect(await escrow.read.totalChipsOutstanding()).to.equal(TIER_CHIPS[1] * 2n);
    });

    it('is arbiter-only and single-shot', async () => {
      const { escrow, arbiter, alice, bob } = await seated();
      await expect(
        (await as(escrow, bob)).write.settleTable([TABLE_A, bob.account.address, 500n]),
      ).to.be.rejected;

      await (await as(escrow, arbiter)).write.settleTable([TABLE_A, alice.account.address, 500n]);
      await expect(
        (await as(escrow, arbiter)).write.settleTable([TABLE_A, alice.account.address, 0n]),
      ).to.be.rejected;
    });

    it('rejects mismatched settlement arrays', async () => {
      const { escrow, arbiter, alice } = await seated();
      await expect(
        (await as(escrow, arbiter)).write.settleTableMulti([
          TABLE_A,
          [alice.account.address],
          [100n, 200n],
        ]),
      ).to.be.rejected;
    });
  });

  describe('refunds', () => {
    async function seated() {
      const ctx = await loadFixture(deployFixture);
      for (const w of [ctx.alice, ctx.bob]) {
        await (await as(ctx.escrow, w)).write.buyChips([2], { value: TIER_PRICES[1] });
        await (await as(ctx.escrow, w)).write.lockChipsForTable([TABLE_A, 250n]);
      }
      return ctx;
    }

    it('lets the arbiter unwind an aborted table immediately', async () => {
      const { escrow, arbiter, alice, bob } = await seated();
      await (await as(escrow, arbiter)).write.refundTable([TABLE_A]);
      expect(await escrow.read.userChipBalance([alice.account.address])).to.equal(TIER_CHIPS[1]);
      expect(await escrow.read.userChipBalance([bob.account.address])).to.equal(TIER_CHIPS[1]);
    });

    it('holds third-party refunds until the delay elapses, then allows them', async () => {
      const { escrow, carol, alice } = await seated();
      const carolEscrow = await as(escrow, carol);
      await expect(carolEscrow.write.refundTable([TABLE_A])).to.be.rejected;

      await time.increase(7 * 24 * 60 * 60 + 1);
      await carolEscrow.write.refundTable([TABLE_A]);
      expect(await escrow.read.userChipBalance([alice.account.address])).to.equal(TIER_CHIPS[1]);
    });

    it('cannot be replayed to double-credit stakes', async () => {
      const { escrow, arbiter } = await seated();
      await (await as(escrow, arbiter)).write.refundTable([TABLE_A]);
      await expect((await as(escrow, arbiter)).write.refundTable([TABLE_A])).to.be.rejected;
    });
  });

  describe('withdrawals', () => {
    it('redeems chips for tBNB at the configured rate', async () => {
      const { escrow, alice, publicClient } = await loadFixture(deployFixture);
      const aliceEscrow = await as(escrow, alice);
      await aliceEscrow.write.buyChips([2], { value: TIER_PRICES[1] });

      const before = await publicClient.getBalance({ address: alice.account.address });
      const hash = await aliceEscrow.write.withdrawChips([400n]);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      const gas = receipt.gasUsed * receipt.effectiveGasPrice;
      const after = await publicClient.getBalance({ address: alice.account.address });

      expect(after - before + gas).to.equal(400n * WEI_PER_CHIP);
      expect(await escrow.read.userChipBalance([alice.account.address])).to.equal(600n);
      expect(await escrow.read.totalChipsOutstanding()).to.equal(600n);
    });

    it('rejects withdrawing more chips than held', async () => {
      const { escrow, alice } = await loadFixture(deployFixture);
      const aliceEscrow = await as(escrow, alice);
      await aliceEscrow.write.buyChips([1], { value: TIER_PRICES[0] });
      await expect(aliceEscrow.write.withdrawChips([101n])).to.be.rejected;
      await expect(aliceEscrow.write.withdrawChips([0n])).to.be.rejected;
    });

    it('can be switched off by setting the rate to zero', async () => {
      const { escrow, owner, alice } = await loadFixture(deployFixture);
      await (await as(escrow, owner)).write.setWeiPerChip([0n]);
      const aliceEscrow = await as(escrow, alice);
      await aliceEscrow.write.buyChips([1], { value: TIER_PRICES[0] });
      await expect(aliceEscrow.write.withdrawChips([10n])).to.be.rejected;
    });
  });

  describe('house accounting', () => {
    it('reports no surplus when every chip is backed', async () => {
      const { escrow, alice } = await loadFixture(deployFixture);
      await (await as(escrow, alice)).write.buyChips([2], { value: TIER_PRICES[1] });
      expect(await escrow.read.houseSurplus()).to.equal(0n);
    });

    it('stops the owner withdrawing the reserve backing player chips', async () => {
      const { escrow, owner, alice } = await loadFixture(deployFixture);
      await (await as(escrow, alice)).write.buyChips([2], { value: TIER_PRICES[1] });
      await expect(
        (await as(escrow, owner)).write.withdrawHouse([owner.account.address, 1n]),
      ).to.be.rejected;
    });

    it('lets the owner withdraw only genuine surplus', async () => {
      const { escrow, owner, alice, publicClient } = await loadFixture(deployFixture);
      await (await as(escrow, alice)).write.buyChips([2], { value: TIER_PRICES[1] });

      // Simulate rake revenue arriving as plain tBNB.
      await owner.sendTransaction({ to: escrow.address, value: parseEther('0.01') });
      expect(await escrow.read.houseSurplus()).to.equal(parseEther('0.01'));

      const hash = await (await as(escrow, owner)).write.withdrawHouse([
        alice.account.address,
        parseEther('0.01'),
      ]);
      await publicClient.waitForTransactionReceipt({ hash });
      expect(await escrow.read.houseSurplus()).to.equal(0n);
    });
  });

  describe('administration', () => {
    it('rotates the arbiter', async () => {
      const { escrow, owner, carol, arbiter, alice, bob } = await loadFixture(deployFixture);
      for (const w of [alice, bob]) {
        await (await as(escrow, w)).write.buyChips([2], { value: TIER_PRICES[1] });
        await (await as(escrow, w)).write.lockChipsForTable([TABLE_A, 250n]);
      }
      await (await as(escrow, owner)).write.setArbiter([carol.account.address]);

      await expect(
        (await as(escrow, arbiter)).write.settleTable([TABLE_A, alice.account.address, 500n]),
      ).to.be.rejected;
      await (await as(escrow, carol)).write.settleTable([TABLE_A, alice.account.address, 500n]);
    });

    it('reconfigures a tier', async () => {
      const { escrow, owner, alice } = await loadFixture(deployFixture);
      await (await as(escrow, owner)).write.configureTier([1, parseEther('0.002'), 150n]);
      await (await as(escrow, alice)).write.buyChips([1], { value: parseEther('0.002') });
      expect(await escrow.read.userChipBalance([alice.account.address])).to.equal(150n);
    });

    it('refuses admin calls from non-owners', async () => {
      const { escrow, alice } = await loadFixture(deployFixture);
      const aliceEscrow = await as(escrow, alice);
      await expect(aliceEscrow.write.setArbiter([alice.account.address])).to.be.rejected;
      await expect(aliceEscrow.write.setPaused([true])).to.be.rejected;
      await expect(aliceEscrow.write.setWeiPerChip([1n])).to.be.rejected;
    });

    it('transfers ownership in two steps', async () => {
      const { escrow, owner, carol } = await loadFixture(deployFixture);
      await (await as(escrow, owner)).write.transferOwnership([carol.account.address]);
      expect(getAddress(await escrow.read.owner())).to.equal(getAddress(owner.account.address));

      await (await as(escrow, carol)).write.acceptOwnership();
      expect(getAddress(await escrow.read.owner())).to.equal(getAddress(carol.account.address));
      expect(await escrow.read.pendingOwner()).to.equal(zeroAddress);
    });
  });
});
