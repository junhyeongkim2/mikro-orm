import { Entity, MikroORM, PrimaryKey, Property, TransactionPropagation } from '@mikro-orm/mssql';

@Entity()
class TestEntity {

  @PrimaryKey()
  id!: number;

  @Property()
  name!: string;

}

describe('Transaction Propagation - MSSQL', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init({
      entities: [TestEntity],
      dbName: 'mikro_orm_test_propagation',
      password: 'Root.Root',
      ensureDatabase: { create: true },
    });
    await orm.schema.refreshDatabase();
  });

  afterAll(() => orm.close(true));

  beforeEach(async () => {
    await orm.em.nativeDelete(TestEntity, {});
  });

  describe('REQUIRED propagation', () => {
    it('should join existing transaction', async () => {
      const em = orm.em.fork();
      let outerTrx: any;
      let innerTrx: any;

      await em.transactional(async em1 => {
        outerTrx = (em1 as any).transactionContext;

        await em1.transactional(async em2 => {
          innerTrx = (em2 as any).transactionContext;
          const entity = em2.create(TestEntity, { name: 'test' });
          await em2.persistAndFlush(entity);
        }, { propagation: TransactionPropagation.REQUIRED });
      });

      expect(outerTrx).toBeDefined();
      expect(innerTrx).toBe(outerTrx); // Should be same transaction

      const count = await orm.em.count(TestEntity);
      expect(count).toBe(1);
    });
  });

  describe('REQUIRES_NEW propagation', () => {
    it('should create new independent transaction', async () => {
      const em = orm.em.fork();
      let outerTrx: any;
      let innerTrx: any;

      await em.transactional(async em1 => {
        outerTrx = (em1 as any).transactionContext;
        const entity1 = em1.create(TestEntity, { name: 'outer' });
        await em1.persistAndFlush(entity1);

        await em1.transactional(async em2 => {
          innerTrx = (em2 as any).transactionContext;
          const entity2 = em2.create(TestEntity, { name: 'inner' });
          await em2.persistAndFlush(entity2);
        }, { propagation: TransactionPropagation.REQUIRES_NEW });
      });

      expect(outerTrx).toBeDefined();
      expect(innerTrx).toBeDefined();
      expect(innerTrx).not.toBe(outerTrx); // Should be different transactions

      const count = await orm.em.count(TestEntity);
      expect(count).toBe(2);
    });
  });

  describe('NESTED propagation', () => {
    it('should create savepoint when transaction exists', async () => {
      const em = orm.em.fork();

      await em.transactional(async em1 => {
        const entity1 = em1.create(TestEntity, { name: 'outer' });
        await em1.persistAndFlush(entity1);

        try {
          await em1.transactional(async em2 => {
            const entity2 = em2.create(TestEntity, { name: 'inner' });
            await em2.persistAndFlush(entity2);
            throw new Error('Rollback inner');
          }, { propagation: TransactionPropagation.NESTED });
        } catch (e) {
          // Inner transaction rolled back to savepoint
        }

        const entity3 = em1.create(TestEntity, { name: 'after' });
        await em1.persistAndFlush(entity3);
      });

      const entities = await orm.em.find(TestEntity, {});
      expect(entities).toHaveLength(2);
      expect(entities.map(e => e.name)).toEqual(expect.arrayContaining(['outer', 'after']));
    });
  });

  describe('NOT_SUPPORTED propagation', () => {
    it('should execute without transaction', async () => {
      const em = orm.em.fork();

      await em.transactional(async em1 => {
        const entity1 = em1.create(TestEntity, { name: 'with-tx' });
        await em1.persistAndFlush(entity1);

        await em1.transactional(async em2 => {
          const entity2 = em2.create(TestEntity, { name: 'without-tx' });
          await em2.persistAndFlush(entity2);
        }, { propagation: TransactionPropagation.NOT_SUPPORTED });
      });

      const count = await orm.em.count(TestEntity);
      expect(count).toBe(2);
    });
  });
});
