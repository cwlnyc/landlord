/** Someone with a phone: a landlord or a tenant. */
export type Person = { name: string; phone: string };

/** A rental unit and who lives there. */
export type Unit = {
  id: string;
  address: string;
  tenant: Person;
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
};

export type State = {
  /** Everyone who runs the rentals. All get the updates; any can reply. */
  landlords: Person[];
  units: Unit[];
  vendors: Vendor[];
  repairs: Repair[];
  nextId: number;
};

/** A text to send. The simulator shows it; later Twilio sends it. */
export type Outbound = { to: string; body: string };
