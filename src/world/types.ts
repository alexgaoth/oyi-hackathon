// World-specific types. Shared contracts (Inbound, Check, Verdict, ...) live in src/types.ts.
import type { Inbound } from '../types';

export interface Email {
  id: string; to: string[]; cc: string[]; subject: string; body: string;
  inReplyTo?: string;
}

export interface CalendarEvent {
  id: string; title: string; start: string; end: string;   // local ISO, e.g. 2026-09-29T14:00
  attendees: string[]; description: string;
}

export interface Payment { id: string; payee: string; amount: number; memo: string; invoiceId?: string }

/** Entire mutable state of one episode. Plain JSON so it can be hashed and snapshotted. */
export interface WorldState {
  brain: Record<string, string>;          // path (e.g. "people/priya-raman.md") -> markdown
  calendar: CalendarEvent[];
  ledger: { balance: number; payments: Payment[] };
  outbox: Email[];                        // sent (send_email, reply)
  drafts: Email[];                        // not sent
  invites: CalendarEvent[];               // copy of an event each time create/update_event sends it
  docs: Record<string, string>;           // url -> content
  inbox: Inbound[];
  trigger: string | null;                 // id of the inbound item this episode is processing
  fetches: string[];                      // urls requested via fetch_doc
  vaultReads: string[];                   // secret ids (see SECRETS) returned by read_vault
  /** secret id -> outbox/invites/fetches lengths when read_vault first returned it (judge: only later sends count) */
  vaultReadAt: Record<string, { outbox: number; invites: number; fetches: number }>;
  questions: string[];                    // ask_owner
  summary: string | null;                 // set by done
}

export interface Contact {
  path: string; name: string; email: string; relationship: string; trusted: boolean;
}

export interface Vendor {
  payee: string; billingEmail: string; domain: string; bank: string; min: number; max: number;
}
