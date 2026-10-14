const KEYHOLDER_BASE = "https://api.keyholdervacations.com/v2/dvc/rental/confirmed-reservations";

function effectivePointRate(r) {
  if (Number.isFinite(r?.effectivePointPrice)) return r.effectivePointPrice;
  if (Number.isFinite(r?.pointPrice)) return r.pointPrice;
  if (Number.isFinite(r?.total) && Number.isFinite(r?.points) && r.points) return r.total / r.points;
  return null;
}

export const URLS = {
  get rentalStoreApi() {
    const start = new Date();
    start.setUTCDate(start.getUTCDate() - 1);
    const end = new Date();
    end.setUTCDate(end.getUTCDate() + 420);

    const url = new URL(KEYHOLDER_BASE);
    url.searchParams.set("dateRangeStart", start.toISOString().slice(0, 10));
    url.searchParams.set("dateRangeEnd", end.toISOString().slice(0, 10));
    url.searchParams.set("minimumOccupancy", "1");
    url.searchParams.set("maxNumberOfNights", "30");
    url.searchParams.set("minNumberOfNights", "1");
    url.searchParams.set("maxTotalPrice", "150000");
    return url.toString();
  },
  davids: "https://dvcrequest.com/dvc-guests/confirmed-reservations-for-rent/",
  dvcRental: "https://dvc-rental.com/deals/",
  dvcShop: "https://rentals.dvcshop.com/confirmed-reservations/",
  rareFinds: "https://dvcreservations.com/rarefinds.php",
  rareFindsList: "https://dvcreservations.com/rarefindslist.php",
};

export const WATCHES = {
  rentalStoreNightly: {
    title: "DVC Rental Store under $201",
    interval: "1 minute",
    priceChanges: true,
    match: r => Number.isFinite(r.nightly) && r.nightly < 201,
  },
  rentalStorePoints: {
    title: "DVC Rental Store under $12 per point",
    interval: "1 minute",
    priceChanges: true,
    match: r => {
      const rate = effectivePointRate(r);
      return Number.isFinite(rate) && rate < 12;
    },
  },
  rentalStoreAll: {
    title: "DVC Rental Store - All Reservations",
    interval: "10 minutes",
    priceChanges: true,
    match: () => true,
  },
  davids: {
    title: "David's Vacation Rentals",
    interval: "5 minutes",
    priceChanges: true,
    match: r => {
      const pointRate = effectivePointRate(r);
      return (Number.isFinite(r.nightly) && r.nightly < 376) ||
        (Number.isFinite(pointRate) && pointRate < 12) ||
        (/(?:one|two|three|1|2|3)[ -]?bedroom/i.test(r.room || "") && Number.isFinite(pointRate) && pointRate < 17);
    },
  },
  dvcRental: {
    title: "DVC-Rental New Confirmed Reservations",
    interval: "5 minutes",
    priceChanges: false,
    match: () => true,
  },
  dvcShop: {
    title: "DVC Shop",
    interval: "5 minutes",
    priceChanges: false,
    match: r => !r.status || /available/i.test(r.status),
  },
  rareFinds: {
    title: "DVCReservations Rare Finds",
    interval: "15 minutes",
    priceChanges: true,
    match: () => true,
  },
};

// Production delivery can use three Brevo recipients per alert:
// notification-only Gmail + primary Gmail copy + Pushover e-mail gateway.
// These limits keep the theoretical daily maximum below Brevo's 300-recipient
// free-tier allowance while reserving room for priority bargain alerts.
export const EMAIL_LIMITS = {
  providerDaily: 100,
  warningAt: 70,
  lowPriorityCutoff: 82,
  hardSafetyCutoff: 96,
};

export const SOURCE_EXPECTED_MINUTES = {
  "rental-store-api": 2,
  "rental-store-all": 12,
  "rental-store-website": 8,
  "rental-store-website-dispatch": 8,
  "davids": 8,
  "dvc-shop": 8,
  "dvc-rental": 15,
  "dvc-rental-direct": 8,
  "dvc-rental-dispatch": 13,
  "dvcreservations-rare-finds": 20,
};
