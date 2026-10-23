export type Role =
  | 'ADMIN'
  | 'VENDOR'
  | 'PROCUREMENT_OFFICER'
  | 'PPK'
  | 'FINANCE'
  | 'AUTHORIZED_OFFICER'
  | 'PAYMENT_SYSTEM'
  | 'AUDITOR';

export type UserStatus = 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
export type VendorStatus = 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
export type POStatus = 'DRAFT' | 'ISSUED' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'VERIFIED' | 'CANCELLED';

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  organization: {
    id: string;
    name: string;
    code: string;
    address?: string;
  };
}

export interface Vendor {
  id: string;
  vendor_code: string;
  legal_name: string;
  tax_id: string;
  address: string;
  contact_email: string;
  organization_id: string;
  status: VendorStatus;
  created_at: string;
}

export interface PurchaseOrderItem {
  id: string;
  po_id: string;
  description: string;
  quantity: string;
  unit_price: string;
  total_price: string;
  created_at: string;
}

export interface PurchaseOrder {
  id: string;
  po_number: string;
  vendor_id: string;
  buyer_organization_id: string;
  description: string;
  total_amount: string;
  currency: string;
  issue_date: string | null;
  due_date: string;
  status: POStatus;
  blockchain_status: string;
  document_hash?: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  vendor?: {
    id: string;
    vendor_code: string;
    legal_name: string;
  };
  buyer_organization?: {
    id: string;
    name: string;
    code: string;
  };
  created_by_user?: {
    id: string;
    name: string;
    email: string;
    role: Role;
  };
  items?: PurchaseOrderItem[];
  audit_events?: ApplicationEvent[];
  blockchain_transactions?: BlockchainTransaction[];
}

export interface ApplicationEvent {
  id: string;
  event_type: string;
  entity_id: string;
  entity_type: string;
  actor_id: string | null;
  organization_id: string | null;
  payload: Record<string, any>;
  status: 'PENDING' | 'PROCESSING' | 'CONFIRMED' | 'FAILED';
  attempt_count: number;
  last_error: string | null;
  created_at: string;
  processed_at: string | null;
}

export interface BlockchainTransaction {
  id: string;
  application_event_id: string;
  transaction_id: string;
  event_type: string;
  entity_id: string;
  entity_type: string;
  status: 'CONFIRMED' | 'FAILED';
  error_message: string | null;
  submitted_at: string;
  confirmed_at: string | null;
}

export interface LedgerHistoryEvent {
  event_id: string;
  event_type: string;
  actor_id: string;
  actor_role: string;
  organization_id: string;
  amount_minor: string;
  currency: string;
  timestamp: string;
  blockchain_transaction_id?: string;
}

export interface LedgerHistoryResponse {
  entity_id: string;
  entity_type: string;
  events: LedgerHistoryEvent[];
  source: string;
}

export interface VerifyHashResponse {
  entity_id: string;
  document_hash: string;
  match: boolean;
  stored_hash?: string;
  matching_events?: any[];
  source: string;
}

export interface BlockchainStatusResponse {
  provider: 'fabric' | 'mock' | string;
  provider_name: string;
  channel: string;
  chaincode: string;
  status: string;
  connected?: boolean;
  timestamp: string;
}

