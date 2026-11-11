/** Someone with a phone: a landlord or a tenant. */
export type Person = { name: string; phone: string };

/** A rental unit and who lives there. */
export type Unit = {
  id: string;
  address: string;
  /** Where to search for repair people. Read from the address if missing. */
  town?: string;
  tenant: Person;
  /** Monthly rent in dollars. No rent, no reminders for this unit. */
  rent?: number;
  /** Day of the month rent is due (default 1; 31 means the last day). */
  rentDue?: number;
};

/** A business the search turned up, for the landlord to call. */
export type Found = {
  name: string;
  phone: string;
  rating?: number | null;
  reviews?: number | null;
  /** Short and useful: "open 24 hours", "emergency service". */
  note?: string | null;
  /** The trade searched for; set when results are saved. */
  trade?: string;
};

/**
 * A repair person. `code` is the short word a landlord texts to pick them,
 * like "JOHN" or "HVAC", the same way Mom names them in her phone.
 */
export type Vendor = {
  code: string;
  name: string;
  trade: string;
  town: string;
  phone: string;
  /**
   * False for a business found by search and booked by phone: it never
   * signed up for texts and may be a landline, so the bot never texts it.
   */
  textable?: boolean;
};

export type RepairStatus =
  | "new" // tenant reported it; nobody asked yet
  | "asking-vendor" // waiting for the repair person to name a time
  | "asking-tenant" // waiting for the tenant to say they'll be home
  | "confirmed" // time agreed by both
  | "done"
  | "cancelled";

export type Repair = {
  id: number;
  unitId: string;
  text: string;
  status: RepairStatus;
  createdAt: string;
  vendorCode?: string;
  /** The proposed or agreed visit, as an ISO time. */
  slot?: string;
  /** Set once the day-before reminder went out. */
  reminded?: boolean;
  /** Set once the landlord was asked whether it got fixed. */
  checkedBack?: boolean;
  /** Who the bot suggested, waiting on the landlord's YES. */
  suggested?: string;
  /** The trade the job needs, from the words or the AI; else read from `text`. */
  trade?: string;
  /** Repair people who already said no, so they aren't suggested again. */
  tried?: string[];
};

export type State = {
  /** Everyone who runs the rentals. All get the updates; any can reply. */
  landlords: Person[];
  units: Unit[];
  vendors: Vendor[];
  repairs: Repair[];
  nextId: number;
  /** Search results per repair id, numbered as the landlord saw them. */
  found?: Record<string, Found[]>;
  /** The repair the latest search was for, so "BOOKED 1 …" needs no id. */
  lastFound?: number;
  /** The last text the line sent each number, so a short answer is read in context. */
  lastSent?: Record<string, string>;
  /** Landlords the line just asked "what kind of repair person?", by number, with the repair. */
  pendingFind?: Record<string, number>;
  /** A shared contact whose trade the bot asked about. */
  pendingContact?: { name: string; phone: string };
  /** Rent the landlord marked paid. Tracking only; no money moves. */
  payments?: import("./rent.js").Payment[];
  /** When rent tracking began; nothing due before it gets a notice. */
  rentSince?: string;
  /** Rent texts already sent, by "unitId|2026-11". */
  rentNotices?: Record<string, string[]>;
  /** Numbers (digits) that texted STOP. Never texted until they text START. */
  optedOut?: string[];
  /** Numbers that got the first-text explanation (who, why, how to stop). */
  welcomed?: string[];
  /** How and when each number agreed or opted out, kept as a record. */
  consent?: Record<string, { at: string; how: string }>;
  /** Defaults: remind 3 days before, late notice 5 days after, at 9am. */
  rentSettings?: { remindDaysBefore?: number; graceDays?: number; hour?: number };
};

/** A text to send. The simulator shows it; later Twilio sends it. */
export type Outbound = { to: string; body: string };
