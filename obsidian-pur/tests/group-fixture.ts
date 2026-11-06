import { Matrix } from "../src/board";
import { extractDatabase, sqlite } from "../src/parser";
import { wrapDatabase } from "../src/writer";

export const parentMatrix: Matrix = [2, 0.4, -0.3, 1.5, 120, -70];
export const nestedMatrix: Matrix = [0, -0.5, -0.8, 0.2, -40, 60];

export function transformText(matrix: Matrix): Uint8Array {
  const bytes = new Uint8Array(77), view = new DataView(bytes.buffer);
  view.setUint32(0, 80);
  [matrix[0], matrix[1], 0, matrix[2], matrix[3], 0, matrix[4], matrix[5], 1]
    .forEach((value, i) => view.setFloat64(5 + i * 8, value));
  return new TextEncoder().encode(Array.from(bytes, value => String.fromCharCode(value)).join(""));
}

export async function groupFixture(): Promise<Uint8Array> {
  const original = new Uint8Array(readFileSync(new URL(
    "../../crates/purcore/tests/fixtures/S1_redbar-new.pur", import.meta.url)));
  const SQL = await sqlite(), db = new SQL.Database(extractDatabase(original));
  try {
    for (const [id, parent, z, matrix] of [
      [100, -1, 10, parentMatrix], [101, -1, 30, [1, 0, 0, 1, 0, 0]],
      [110, 100, 3, nestedMatrix],
    ] as [number, number, number, Matrix][]) {
      db.run("INSERT INTO items(id,parent,z,opacity,locked,transform) VALUES(?,?,?,1,0,CAST(? AS TEXT))",
        [id, parent, z, transformText(matrix)]);
      db.run("INSERT INTO items_groups(id,lock_mode) VALUES(?,1)", [id]);
    }
    db.run("UPDATE items SET parent=100,z=1 WHERE id=0");
    for (const [id, parent, z] of [[1, 100, 1000], [2, 110, 2], [3, -1, 20]]) {
      db.run(`INSERT INTO items(id,parent,z,opacity,locked,transform,sort_order,name,comment)
        SELECT ?,?,?,opacity,locked,transform,sort_order,name,comment FROM items WHERE id=0`, [id, parent, z]);
      db.run(`INSERT INTO items_images(id,image,image_transform,image_bounds,flags,playback_state,playback_frame)
        SELECT ?,image,image_transform,image_bounds,flags,playback_state,playback_frame FROM items_images WHERE id=0`, [id]);
    }
    return wrapDatabase(original, db.export());
  } finally { db.close(); }
}
import { readFileSync } from "node:fs";
