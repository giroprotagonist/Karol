import { describe, expect, it } from 'vitest';
import { reorderItemsLocally } from './QueueList';

describe('reorderItemsLocally', () => {
	const items = [
		{ id: 'a', title: 'A' },
		{ id: 'b', title: 'B' },
		{ id: 'c', title: 'C' },
	];

	it('moves item down the list', () => {
		const next = reorderItemsLocally(items, 0, 2);
		expect(next.map((i) => i.id)).toEqual(['b', 'c', 'a']);
	});

	it('moves item up the list', () => {
		const next = reorderItemsLocally(items, 2, 0);
		expect(next.map((i) => i.id)).toEqual(['c', 'a', 'b']);
	});
});
