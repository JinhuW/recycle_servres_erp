import { describe, it, expect } from 'vitest';
import { inventoryLabel, inventorySpec, type InventoryAttrs } from '../src/lib/inventoryLabel';

const base: InventoryAttrs = {
  category: 'RAM', brand: null, capacity: null, generation: null, type: null,
  classification: null, rank: null, speed: null, interface: null,
  form_factor: null, description: null, condition: null, health: null, rpm: null,
};

describe('inventoryLabel', () => {
  it('RAM joins brand + capacity + generation', () => {
    expect(inventoryLabel({ ...base, category: 'RAM', brand: 'Samsung', capacity: '32GB', generation: 'DDR4' }))
      .toBe('Samsung 32GB DDR4');
  });
  it('SSD joins brand + capacity', () => {
    expect(inventoryLabel({ ...base, category: 'SSD', brand: 'Intel', capacity: '960GB' }))
      .toBe('Intel 960GB');
  });
  it('Other falls back to description', () => {
    expect(inventoryLabel({ ...base, category: 'Other', description: 'NIC card' }))
      .toBe('NIC card');
  });
});

describe('inventorySpec', () => {
  it('RAM joins classification · rank · speedMHz', () => {
    expect(inventorySpec({ ...base, category: 'RAM', classification: 'RDIMM', rank: '2Rx4', speed: '3200' }))
      .toBe('RDIMM · 2Rx4 · 3200MHz');
  });
  it('SSD joins interface · form · health%', () => {
    expect(inventorySpec({ ...base, category: 'SSD', interface: 'NVMe', form_factor: 'M.2', health: 98 }))
      .toBe('NVMe · M.2 · 98%');
  });
  it('returns null when nothing composes', () => {
    expect(inventorySpec({ ...base, category: 'RAM' })).toBeNull();
  });
});
