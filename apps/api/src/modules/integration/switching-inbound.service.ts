import { DatabaseService, DbVendor } from '../../database/db.service.ts';
import { AuthenticatedUser, Role, UserStatus } from '../../common/types.ts';
import { AppError } from '../../common/response.dto.ts';
import { PurchaseOrdersService, CreatePOItemDto } from '../purchase-orders/po.service.ts';
import { VendorsService, UpdateVendorDto } from '../vendors/vendors.service.ts';

export const PO_ISSUED_TRANSACTION_TYPE = 'PO_ISSUED';

/** Payload yang dikirim Switching Hub pada Jalur A (business service). */
export interface SwitchingVendorPayload {
  code?: string;
  legalName?: string;
  taxId?: string;
  address?: string;
  email?: string;
}

export interface SwitchingLedgerEventBody {
  businessTransactionId?: string;
  transactionType?: string;
  switchingTransactionId?: string;
  correlationId?: string;
  payload?: {
    poNumber?: string;
    description?: string;
    currency?: string;
    dueDate?: string;
    vendor?: SwitchingVendorPayload;
    items?: Array<{ description?: string; quantity?: number | string; unitPrice?: string }>;
  };
}

/**
 * Menerima peristiwa bisnis yang didorong Switching Hub ke BukuPencatatan.
 *
 * Switching hanya berlaku sebagai pipa: ia meneruskan `transformedPayload`
 * milik transaksi e-commerce tanpa header autentikasi apa pun. Karena itu
 * endpoint ini dijaga oleh token statis (dicek di routes.ts), dan setiap
 * peristiwa di-dedupe berdasarkan `businessTransactionId` karena Switching
 * tidak mengirim `Idempotency-Key` pada jalur bisnis.
 */
export class SwitchingInboundService {
  private db = DatabaseService.getInstance();
  private vendorsService = new VendorsService();
  private poService = new PurchaseOrdersService();

  async handleLedgerEvent(body: SwitchingLedgerEventBody) {
    const businessTransactionId = body.businessTransactionId?.trim();
    if (!businessTransactionId) {
      throw new AppError('VALIDATION_ERROR', 'businessTransactionId is required');
    }

    const transactionType = body.transactionType?.trim();
    if (transactionType !== PO_ISSUED_TRANSACTION_TYPE) {
      return {
        received: true,
        applied: false,
        reason: `Unsupported transactionType '${transactionType ?? ''}'`,
        supportedTransactionTypes: [PO_ISSUED_TRANSACTION_TYPE],
      };
    }

    const alreadyAppliedPoId = this.findAppliedPurchaseOrder(businessTransactionId);
    if (alreadyAppliedPoId) {
      const existing = this.db.purchase_orders.get(alreadyAppliedPoId);
      return {
        received: true,
        applied: false,
        duplicated: true,
        businessTransactionId,
        po_id: alreadyAppliedPoId,
        po_number: existing?.po_number ?? null,
      };
    }

    const payload = body.payload ?? {};

    // Seluruh data PO (nomor, deskripsi, mata uang, jatuh tempo, vendor, item,
    // harga) milik e-commerce dan diteruskan apa adanya oleh Switching. Tidak
    // ada nilai cadangan di sini: field yang tidak dikirim selalu ditolak.
    const poNumber = payload.poNumber?.trim();
    if (!poNumber) {
      throw new AppError('VALIDATION_ERROR', 'payload.poNumber is required');
    }

    const description = payload.description?.trim();
    if (!description) {
      throw new AppError('VALIDATION_ERROR', 'payload.description is required');
    }

    const currency = payload.currency?.trim();
    if (!currency) {
      throw new AppError('VALIDATION_ERROR', 'payload.currency is required');
    }

    const dueDate = payload.dueDate?.trim();
    if (!dueDate) {
      throw new AppError('VALIDATION_ERROR', 'payload.dueDate is required');
    }

    const systemUser = this.resolveSystemUser();
    const vendor = await this.resolveVendor(payload.vendor, systemUser);
    const items = this.mapItems(payload.items);

    const po = await this.poService.createPO(
      {
        vendor_id: vendor.id,
        description,
        currency,
        due_date: dueDate,
        items,
        external_ref: businessTransactionId,
        external_po_number: poNumber,
      },
      systemUser,
    );

    return {
      received: true,
      applied: true,
      duplicated: false,
      businessTransactionId,
      switchingTransactionId: body.switchingTransactionId ?? null,
      correlationId: body.correlationId ?? null,
      po_id: po.id,
      po_number: po.po_number,
      vendor_id: vendor.id,
      total_amount: po.total_amount,
      currency: po.currency,
    };
  }

  /** Dedupe Jalur A: Switching tidak mengirim Idempotency-Key, jadi jejak disimpan di event PO_CREATED. */
  private findAppliedPurchaseOrder(businessTransactionId: string): string | null {
    for (const event of this.db.application_events.values()) {
      if (event.event_type !== 'PO_CREATED') continue;
      const ref = event.payload?.external_ref;
      if (typeof ref === 'string' && ref === businessTransactionId) {
        return event.entity_id;
      }
    }
    return null;
  }

  /**
   * Peristiwa masuk tidak punya konteks pengguna. Diatribusikan ke ADMIN aktif
   * pertama supaya jejak audit dan kepemilikan organisasi tetap konsisten.
   */
  private resolveSystemUser(): AuthenticatedUser {
    const admin = Array.from(this.db.users.values()).find(
      (user) => user.role === Role.ADMIN && user.status === UserStatus.ACTIVE,
    );
    if (!admin) {
      throw new AppError(
        'SYSTEM_USER_UNAVAILABLE',
        'No active ADMIN user available to attribute inbound transactions',
        503,
      );
    }
    return {
      id: admin.id,
      name: admin.name,
      email: admin.email,
      role: admin.role,
      organizationId: admin.organization_id,
      status: admin.status,
    };
  }

  /**
   * Data vendor datang dari e-commerce bersama PO-nya, karena Switching tidak
   * menyimpan master vendor sama sekali. Kita tidak pernah mengisi nilai
   * cadangan (mis. '-') — kalau e-commerce tidak mengirim field wajibnya,
   * peristiwa ditolak.
   *
   * Vendor yang sudah ada tidak ditimpa diam-diam: hanya field yang benar-benar
   * berbeda yang diperbarui, sehingga perubahan tetap tercatat di ledger.
   */
  private async resolveVendor(
    input: SwitchingVendorPayload | undefined,
    systemUser: AuthenticatedUser,
  ): Promise<DbVendor> {
    const code = input?.code?.trim();
    if (!code) {
      throw new AppError('VALIDATION_ERROR', 'payload.vendor.code is required');
    }
    const legalName = input?.legalName?.trim();
    if (!legalName) {
      throw new AppError('VALIDATION_ERROR', 'payload.vendor.legalName is required');
    }

    const existing = Array.from(this.db.vendors.values()).find(
      (vendor) =>
        vendor.organization_id === systemUser.organizationId &&
        vendor.vendor_code.toUpperCase() === code.toUpperCase(),
    );

    if (!existing) {
      // createVendor menuntut seluruh field identitas terisi, jadi kelengkapan
      // wajib diperiksa di sini agar pesan errornya jelas dan tidak ada placeholder.
      const taxId = input?.taxId?.trim();
      const address = input?.address?.trim();
      const email = input?.email?.trim();
      const missing = [
        !taxId && 'payload.vendor.taxId',
        !address && 'payload.vendor.address',
        !email && 'payload.vendor.email',
      ].filter((field): field is string => Boolean(field));
      if (missing.length > 0) {
        throw new AppError(
          'VALIDATION_ERROR',
          `${missing.join(', ')} required to register new vendor '${code}'`,
        );
      }

      return this.vendorsService.createVendor(
        {
          vendor_code: code,
          legal_name: legalName,
          tax_id: taxId!,
          address: address!,
          contact_email: email!,
        },
        systemUser,
      );
    }

    const changes: UpdateVendorDto = {};
    if (existing.legal_name !== legalName) changes.legal_name = legalName;
    const taxId = input?.taxId?.trim();
    if (taxId && existing.tax_id !== taxId) changes.tax_id = taxId;
    const address = input?.address?.trim();
    if (address && existing.address !== address) changes.address = address;
    const email = input?.email?.trim();
    if (email && existing.contact_email !== email.toLowerCase()) changes.contact_email = email;

    if (Object.keys(changes).length === 0) {
      return existing;
    }
    return this.vendorsService.updateVendor(existing.id, changes, systemUser);
  }

  private mapItems(
    items: Array<{ description?: string; quantity?: number | string; unitPrice?: string }> | undefined,
  ): CreatePOItemDto[] {
    if (!Array.isArray(items) || items.length === 0) {
      throw new AppError('VALIDATION_ERROR', 'payload.items must contain at least one line item');
    }

    return items.map((item, index) => {
      const unitPrice = item?.unitPrice;
      if (
        !item?.description ||
        item.quantity === undefined ||
        item.quantity === null ||
        unitPrice === undefined ||
        unitPrice === null
      ) {
        throw new AppError(
          'VALIDATION_ERROR',
          `payload.items[${index}] requires description, quantity and unitPrice`,
        );
      }
      return {
        description: item.description,
        quantity: item.quantity,
        unit_price: String(unitPrice),
      };
    });
  }
}
