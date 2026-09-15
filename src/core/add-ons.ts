import { eq, inArray } from 'drizzle-orm';
import { db } from './db/index.js';
import {
  addOnsTable,
  bookingAddOnsTable
} from './db/schema.js';

export interface AddOnSelection {
  addOnId: number;
  units: number;
}

export interface AddOnLine {
  addOnId: number;
  itemName: string;
  unitPrice: number;
  itemQuantity: number;
  quantityUnit: string;
  imageUrl: string | null;
  units: number;
  lineTotal: number;
}

export async function resolveAddOnLines(
  selections: AddOnSelection[]
): Promise<{ lines: AddOnLine[]; total: number }> {
  const unitsByAddOnId = new Map<number, number>();
  for (const selection of selections) {
    unitsByAddOnId.set(
      selection.addOnId,
      (unitsByAddOnId.get(selection.addOnId) ?? 0) + selection.units
    );
  }

  const addOnIds = [...unitsByAddOnId.keys()];
  if (addOnIds.length === 0) {
    return { lines: [], total: 0 };
  }

  const addOns = await db
    .select()
    .from(addOnsTable)
    .where(inArray(addOnsTable.id, addOnIds));
  const activeAddOns = addOns.filter((addOn) => addOn.isActive);
  const unavailableIds = addOnIds.filter(
    (id) => !activeAddOns.some((addOn) => addOn.id === id)
  );
  if (unavailableIds.length > 0) {
    throw new Error(`Add-ons not found or inactive: ${unavailableIds.join(', ')}`);
  }

  const lines = activeAddOns.map((addOn) => {
    const units = unitsByAddOnId.get(addOn.id) ?? 0;
    return {
      addOnId: addOn.id,
      itemName: addOn.itemName,
      unitPrice: addOn.price,
      itemQuantity: addOn.quantity,
      quantityUnit: addOn.quantityUnit,
      imageUrl: addOn.imageUrl,
      units,
      lineTotal: addOn.price * units
    };
  });

  return {
    lines,
    total: lines.reduce((sum, line) => sum + line.lineTotal, 0)
  };
}

export async function getBookingAddOnSummary(bookingId: number) {
  const items = await db
    .select({
      id: bookingAddOnsTable.id,
      addOnId: bookingAddOnsTable.addOnId,
      itemName: bookingAddOnsTable.itemName,
      unitPrice: bookingAddOnsTable.unitPrice,
      itemQuantity: bookingAddOnsTable.itemQuantity,
      quantityUnit: bookingAddOnsTable.quantityUnit,
      imageUrl: bookingAddOnsTable.imageUrl,
      units: bookingAddOnsTable.units,
      lineTotal: bookingAddOnsTable.lineTotal,
      addedBy: bookingAddOnsTable.addedBy,
      createdAt: bookingAddOnsTable.createdAt
    })
    .from(bookingAddOnsTable)
    .where(eq(bookingAddOnsTable.bookingId, bookingId));

  return {
    items,
    total: items.reduce((sum, item) => sum + item.lineTotal, 0)
  };
}
