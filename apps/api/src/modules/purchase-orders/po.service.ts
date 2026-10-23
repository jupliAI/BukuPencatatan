import { v4 as uuidv4 } from 'uuid';
import { DatabaseService, DbPurchaseOrder, DbPurchaseOrderItem } from '../../database/db.service.ts';
import { AuthenticatedUser, Role, POStatus, VendorStatus, OutboxStatus } from '../../common/types.ts';
import { AppError } from '../../common/response.dto.ts';
import { MoneyUtils } from '../../common/decimal-utils.ts';
import { checkOrgBoundary } from '../../common/auth.guard.ts';

export interface CreatePOItemDto {
  description: string;
  quantity: number | string;
  unit_price: string;
}

export interface CreatePODto {
  vendor_id: string;
  buyer_organization_id?: string;
  description: string;
  /** Mata uang PO, berasal dari sistem asal (e-commerce). Wajib — tidak ada nilai cadangan. */
  currency: string;
  due_date: string;
  items: CreatePOItemDto[];
  /** Referensi dari sistem asal (mis. businessTransactionId Switching) untuk dedupe peristiwa masuk. */
  external_ref?: string;
  /**
   * Nomor PO milik sistem asal (e-commerce), wajib. Aplikasi tidak pernah
   * menerbitkan nomor PO sendiri.
   */
  external_po_number: string;
}

export interface POFilterQuery {
  status?: POStatus;
  vendor_id?: string;
  search?: string;
  page?: number;
  limit?: number;
}

export class PurchaseOrdersService {
  private db = DatabaseService.getInstance();

  /**
   * PO pada jalur integrasi diterbitkan sistem lain, sehingga nomornya milik
   * sistem asal dan dipakai apa adanya (dengan cek keunikan). Aplikasi tidak
   * pernah membuat nomor PO sendiri: kalau nomor asal tidak ada, PO ditolak.
   */
  private resolvePONumber(requested: string): string {
    const trimmed = requested?.trim();
    if (!trimmed) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Purchase order number from the source system is required',
      );
    }
    for (const po of this.db.purchase_orders.values()) {
      if (po.po_number.toUpperCase() === trimmed.toUpperCase()) {
        throw new AppError('DUPLICATE_PO_NUMBER', `Purchase order number '${trimmed}' already exists`, 409);
      }
    }
    return trimmed;
  }

  async createPO(dto: CreatePODto, currentUser: AuthenticatedUser): Promise<DbPurchaseOrder & { items: DbPurchaseOrderItem[] }> {
    if (
      !dto.vendor_id ||
      !dto.description ||
      !dto.currency ||
      !dto.due_date ||
      !Array.isArray(dto.items) ||
      dto.items.length === 0
    ) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Vendor, description, currency, due date, and at least one item are required',
      );
    }

    const orgId = currentUser.role === Role.ADMIN && dto.buyer_organization_id ? dto.buyer_organization_id : currentUser.organizationId;

    // Validate Vendor
    const vendor = this.db.vendors.get(dto.vendor_id);
    if (!vendor) {
      throw new AppError('VENDOR_NOT_FOUND', `Vendor '${dto.vendor_id}' not found`, 404);
    }
    if (vendor.organization_id !== orgId && currentUser.role !== Role.ADMIN) {
      throw new AppError('FORBIDDEN', 'Cannot assign vendor belonging to another organization', 403);
    }
    if (vendor.status !== VendorStatus.ACTIVE) {
      throw new AppError('INACTIVE_VENDOR', 'Purchase order cannot be created with an inactive vendor', 400);
    }

    // Validate and calculate line items server-side using Decimal.js
    const calculatedItems: DbPurchaseOrderItem[] = [];
    const itemTotals: string[] = [];
    const poId = uuidv4();

    for (const item of dto.items) {
      if (!item.description || item.description.trim() === '') {
        throw new AppError('VALIDATION_ERROR', 'Item description is required');
      }
      if (!MoneyUtils.isValidQuantity(item.quantity)) {
        throw new AppError('INVALID_QUANTITY', 'Item quantity must be strictly greater than zero');
      }
      if (!MoneyUtils.isValidAmount(item.unit_price)) {
        throw new AppError('INVALID_UNIT_PRICE', 'Item unit price must be a valid non-negative amount');
      }

      const totalPrice = MoneyUtils.calculateItemTotal(item.quantity, item.unit_price);
      itemTotals.push(totalPrice);

      calculatedItems.push({
        id: uuidv4(),
        po_id: poId,
        description: item.description.trim(),
        quantity: String(item.quantity),
        unit_price: item.unit_price,
        total_price: totalPrice,
        created_at: new Date(),
      });
    }

    // Calculate server-side total: never trust client for monetary total
    const totalAmount = MoneyUtils.sumTotals(itemTotals);

    const poNumber = this.resolvePONumber(dto.external_po_number);
    const newPO: DbPurchaseOrder = {
      id: poId,
      po_number: poNumber,
      vendor_id: vendor.id,
      buyer_organization_id: orgId,
      description: dto.description.trim(),
      total_amount: totalAmount,
      currency: dto.currency.trim().toUpperCase(),
      issue_date: null,
      due_date: new Date(dto.due_date),
      status: POStatus.DRAFT,
      blockchain_status: 'PENDING',
      created_by: currentUser.id,
      created_at: new Date(),
      updated_at: new Date(),
    };

    // Atomic DB write (simulating single PostgreSQL transaction)
    this.db.purchase_orders.set(newPO.id, newPO);
    for (const item of calculatedItems) {
      this.db.purchase_order_items.set(item.id, item);
    }

    // Create Outbox Application Event (PO_CREATED / PENDING)
    const outboxId = uuidv4();
    this.db.application_events.set(outboxId, {
      id: outboxId,
      event_type: 'PO_CREATED',
      entity_id: newPO.id,
      entity_type: 'PURCHASE_ORDER',
      actor_id: currentUser.id,
      organization_id: orgId,
      payload: {
        po_number: newPO.po_number,
        vendor_id: newPO.vendor_id,
        total_amount: newPO.total_amount,
        currency: newPO.currency,
        items_count: calculatedItems.length,
        external_ref: dto.external_ref ?? null,
      },
      status: OutboxStatus.PENDING,
      attempt_count: 0,
      last_error: null,
      created_at: new Date(),
      processed_at: null,
    });

    return {
      ...newPO,
      items: calculatedItems,
    };
  }

  async getPOs(query: POFilterQuery, currentUser: AuthenticatedUser) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 10));

    let items = Array.from(this.db.purchase_orders.values());

    // Role & Organization boundary
    if (currentUser.role !== Role.ADMIN) {
      items = items.filter((po) => po.buyer_organization_id === currentUser.organizationId);
    }

    if (query.status) {
      items = items.filter((po) => po.status === query.status);
    }

    if (query.vendor_id) {
      items = items.filter((po) => po.vendor_id === query.vendor_id);
    }

    if (query.search) {
      const q = query.search.toLowerCase();
      items = items.filter(
        (po) => po.po_number.toLowerCase().includes(q) || po.description.toLowerCase().includes(q)
      );
    }

    // Sort descending by created_at
    items.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());

    const total = items.length;
    const paginatedPOs = items.slice((page - 1) * limit, page * limit);

    // Attach vendor information & items
    const enrichedPOs = paginatedPOs.map((po) => {
      const vendor = this.db.vendors.get(po.vendor_id);
      const itemsList = Array.from(this.db.purchase_order_items.values()).filter((it) => it.po_id === po.id);
      return {
        ...po,
        vendor: vendor ? { id: vendor.id, vendor_code: vendor.vendor_code, legal_name: vendor.legal_name } : null,
        items_count: itemsList.length,
      };
    });

    return {
      items: enrichedPOs,
      pagination: {
        total,
        page,
        limit,
        total_pages: Math.ceil(total / limit),
      },
    };
  }

  async getPOById(id: string, currentUser: AuthenticatedUser) {
    const po = this.db.purchase_orders.get(id);
    if (!po) {
      throw new AppError('PO_NOT_FOUND', `Purchase order with ID '${id}' not found`, 404);
    }

    if (!checkOrgBoundary(currentUser, po.buyer_organization_id)) {
      throw new AppError('FORBIDDEN', 'Access denied to purchase order belonging to another organization', 403);
    }

    const vendor = this.db.vendors.get(po.vendor_id);
    const org = this.db.organizations.get(po.buyer_organization_id);
    const creator = this.db.users.get(po.created_by);
    const items = Array.from(this.db.purchase_order_items.values()).filter((it) => it.po_id === po.id);

    // Retrieve application events and blockchain transactions for audit trail
    const events = Array.from(this.db.application_events.values())
      .filter((ev) => ev.entity_id === po.id && ev.entity_type === 'PURCHASE_ORDER')
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());

    const eventIds = new Set(events.map((e) => e.id));
    const blockchainTransactions = Array.from(this.db.blockchain_transactions.values()).filter(
      (tx) => tx.entity_id === po.id || eventIds.has(tx.application_event_id)
    );

    return {
      ...po,
      vendor: vendor || null,
      buyer_organization: org || null,
      created_by_user: creator ? { id: creator.id, name: creator.name, email: creator.email, role: creator.role } : null,
      items,
      audit_events: events,
      blockchain_transactions: blockchainTransactions,
    };
  }

  // Tidak ada method untuk mengubah PO di sini: PO hanya lahir dari peristiwa
  // e-commerce yang diteruskan Switching (createPO di atas).
}
