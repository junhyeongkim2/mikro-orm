import { Entity, MikroORM, PrimaryKey, Property, TransactionPropagation } from '@mikro-orm/postgresql';

@Entity()
class TestEntity {

  @PrimaryKey()
  id!: number;

  @Property()
  name!: string;

}

describe('Transaction Suspend/Resume Mechanism', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init({
      entities: [TestEntity],
      dbName: 'mikro_orm_test_suspend_resume',
      ensureDatabase: { create: true },
    });
    await orm.schema.refreshDatabase();
  });

  afterAll(() => orm.close(true));

  beforeEach(async () => {
    await orm.em.nativeDelete(TestEntity, {});
  });

  it('should properly suspend and resume transaction with REQUIRES_NEW', async () => {
    const em = orm.em.fork();
    let outerTxBeforeSuspend: any;
    let outerTxAfterResume: any;
    let innerTx: any;

    await em.transactional(async em1 => {
      // Capture outer transaction context before REQUIRES_NEW
      outerTxBeforeSuspend = (em1 as any).transactionContext;
      const entity1 = em1.create(TestEntity, { name: 'outer-before' });
      await em1.persistAndFlush(entity1);

      // REQUIRES_NEW should suspend outer transaction
      await em1.transactional(async em2 => {
        innerTx = (em2 as any).transactionContext;
        const entity2 = em2.create(TestEntity, { name: 'inner' });
        await em2.persistAndFlush(entity2);
      }, { propagation: TransactionPropagation.REQUIRES_NEW });

      // After REQUIRES_NEW, outer transaction should be resumed
      outerTxAfterResume = (em1 as any).transactionContext;
      const entity3 = em1.create(TestEntity, { name: 'outer-after' });
      await em1.persistAndFlush(entity3);
    });

    // Verify transactions were different
    expect(outerTxBeforeSuspend).toBeDefined();
    expect(innerTx).toBeDefined();
    expect(innerTx).not.toBe(outerTxBeforeSuspend);

    // Verify outer transaction was properly resumed
    expect(outerTxAfterResume).toBe(outerTxBeforeSuspend);

    // Verify all entities were saved
    const count = await orm.em.count(TestEntity);
    expect(count).toBe(3);
  });

  it('should properly suspend and resume with NOT_SUPPORTED', async () => {
    const em = orm.em.fork();
    let outerTxBeforeSuspend: any;
    let outerTxAfterResume: any;
    let duringNotSupported: any;

    await em.transactional(async em1 => {
      // Capture outer transaction context before NOT_SUPPORTED
      outerTxBeforeSuspend = (em1 as any).transactionContext;
      const entity1 = em1.create(TestEntity, { name: 'outer-before' });
      await em1.persistAndFlush(entity1);

      // NOT_SUPPORTED should suspend transaction
      await em1.transactional(async em2 => {
        duringNotSupported = (em2 as any).transactionContext;
        const entity2 = em2.create(TestEntity, { name: 'no-tx' });
        await em2.persistAndFlush(entity2);
      }, { propagation: TransactionPropagation.NOT_SUPPORTED });

      // After NOT_SUPPORTED, outer transaction should be resumed
      outerTxAfterResume = (em1 as any).transactionContext;
      const entity3 = em1.create(TestEntity, { name: 'outer-after' });
      await em1.persistAndFlush(entity3);
    });

    // Verify transaction was suspended during NOT_SUPPORTED
    expect(outerTxBeforeSuspend).toBeDefined();
    // During NOT_SUPPORTED, transactionContext should be undefined (no transaction)
    expect(duringNotSupported).toBeUndefined();

    // Verify outer transaction was properly resumed
    expect(outerTxAfterResume).toBe(outerTxBeforeSuspend);

    // Verify all entities were saved
    const count = await orm.em.count(TestEntity);
    expect(count).toBe(3);
  });
});
