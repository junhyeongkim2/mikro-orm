import { DefaultTransactionStatus } from '@mikro-orm/core';

describe('TransactionStatus', () => {
  it('should track transaction state correctly', () => {
    const transaction = { id: 'test-tx' };
    const status = new DefaultTransactionStatus(transaction, true, false);

    expect(status.getTransaction()).toBe(transaction);
    expect(status.isNewTransaction()).toBe(true);
    expect(status.hasSavepoint()).toBe(false);
    expect(status.isRollbackOnly()).toBe(false);

    status.setRollbackOnly();
    expect(status.isRollbackOnly()).toBe(true);
  });

  it('should track suspended resources', () => {
    const transaction = { id: 'test-tx' };
    const suspended = { id: 'suspended-tx' };
    const status = new DefaultTransactionStatus(transaction, false, true);

    expect(status.getSuspendedResources()).toBeNull();

    status.setSuspendedResources(suspended);
    expect(status.getSuspendedResources()).toBe(suspended);
  });

  it('should correctly identify savepoint transactions', () => {
    const transaction = { id: 'test-tx' };
    const status = new DefaultTransactionStatus(transaction, false, true);

    expect(status.isNewTransaction()).toBe(false);
    expect(status.hasSavepoint()).toBe(true);
  });
});
