/** Fixed-capacity circular buffer holding the most recent values. */
export class RingBuffer<T> {
  private readonly items: T[] = [];
  private head = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`RingBuffer capacity must be a positive integer, got ${capacity}`);
    }
  }

  push(item: T): void {
    if (this.items.length < this.capacity) {
      this.items.push(item);
      return;
    }
    this.items[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
  }

  /** Oldest-to-newest copy of the window. */
  toArray(): T[] {
    if (this.items.length < this.capacity) return [...this.items];
    return [...this.items.slice(this.head), ...this.items.slice(0, this.head)];
  }

  get size(): number {
    return this.items.length;
  }

  get isFull(): boolean {
    return this.items.length === this.capacity;
  }

  clear(): void {
    this.items.length = 0;
    this.head = 0;
  }
}
