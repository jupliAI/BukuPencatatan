import 'dotenv/config';

/**
 * Simulator Switching Hub (Jalur A / business service).
 *
 * Menembak endpoint inbound BukuPencatatan dengan payload yang bentuknya
 * sama seperti yang nanti dikirim Switching Hub sungguhan, sehingga alur
 * dapat diuji end-to-end sebelum routing rule dibuat di sisi Switching.
 *
 * Pemakaian:
 *   npx tsx scripts/simulate-switching.ts
 *   SIMULATE_BASE_URL=https://<deployment> npx tsx scripts/simulate-switching.ts
 */

const baseUrl = process.env.SIMULATE_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
const token = process.env.SWITCHING_INBOUND_TOKEN ?? '';
const endpoint = `${baseUrl}/api/v1/integration/ledger-events?token=${encodeURIComponent(token)}`;

const runId = Date.now().toString(36).toUpperCase();

interface Scenario {
  label: string;
  body: Record<string, unknown>;
}

const scenarios: Scenario[] = [
  {
    label: 'PO dari e-commerce (vendor VEND-001 sudah terdaftar) — harus diterima',
    body: {
      businessTransactionId: `EC-ORDER-${runId}-001`,
      transactionType: 'PO_ISSUED',
      switchingTransactionId: `SWT-${runId}-001`,
      correlationId: `corr-${runId}-001`,
      payload: {
        poNumber: `PO-EC-${runId}-001`,
        description: 'Pengadaan gabah kering 5 ton',
        currency: 'IDR',
        dueDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
        vendor: { code: 'VEND-001' },
        items: [
          { description: 'Gabah kering panen', quantity: 5000, unitPrice: '6200.00' },
          { description: 'Biaya angkut', quantity: 1, unitPrice: '750000.00' },
        ],
      },
    },
  },
  {
    label: 'Vendor belum terdaftar — harus ditolak 409 (kita tidak mengarang vendor)',
    body: {
      businessTransactionId: `EC-ORDER-${runId}-002`,
      transactionType: 'PO_ISSUED',
      switchingTransactionId: `SWT-${runId}-002`,
      payload: {
        poNumber: `PO-EC-${runId}-002`,
        description: 'Pengadaan pupuk NPK',
        currency: 'IDR',
        dueDate: new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 10),
        vendor: { code: 'VEND-BELUM-TERDAFTAR' },
        items: [{ description: 'Pupuk NPK 50kg', quantity: 120, unitPrice: '385000.00' }],
      },
    },
  },
  {
    label: 'Nomor PO tidak dikirim — harus ditolak 400 (nomor PO milik e-commerce)',
    body: {
      businessTransactionId: `EC-ORDER-${runId}-003`,
      transactionType: 'PO_ISSUED',
      payload: {
        description: 'Pengadaan tanpa nomor PO dari sistem asal',
        currency: 'IDR',
        dueDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
        vendor: { code: 'VEND-001' },
        items: [{ description: 'Barang contoh', quantity: 1, unitPrice: '10000.00' }],
      },
    },
  },
  {
    label: 'Tipe transaksi yang belum didukung — harus diabaikan',
    body: {
      businessTransactionId: `EC-ORDER-${runId}-004`,
      transactionType: 'PAYMENT_SETTLED',
      payload: { settlementRef: `STL-${runId}-004` },
    },
  },
];

async function post(label: string, body: Record<string, unknown>) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log(`\n[${res.status}] ${label}`);
  console.log(`  → ${text}`);
  return res.status;
}

async function main() {
  if (!token) {
    console.error('SWITCHING_INBOUND_TOKEN belum diset. Salin .env.example menjadi .env lalu isi nilainya.');
    process.exit(1);
  }

  console.log(`Menembak ${baseUrl}/api/v1/integration/ledger-events`);

  for (const scenario of scenarios) {
    await post(scenario.label, scenario.body);
  }

  // Replay skenario pertama: harus dikenali sebagai duplikat, bukan membuat PO kedua.
  await post('Replay transaksi pertama (uji dedupe)', scenarios[0].body);
}

main().catch((err) => {
  console.error('Simulasi gagal:', err);
  process.exit(1);
});
