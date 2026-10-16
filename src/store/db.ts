import type Database from "better-sqlite3";
import { notImplemented } from "../core/todo.js";

/**
 * Open the node database in WAL mode and apply SCHEMA_SQL (SPEC section 4).
 * Milestone M1.
 */
export function openDatabase(_path: string): Database.Database {
  return notImplemented("openDatabase", "M1");
}
