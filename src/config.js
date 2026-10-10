const KEYHOLDER_BASE = "https://api.keyholdervacations.com/v2/dvc/rental/confirmed-reservations";

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
};

export const WATCHES = {
  rentalStoreNightly: {
    title: "DVC Rental Store under $200",
    interval: "1 minute",
    priceChanges: true,
    // Mirrors the prior ChangeDetection filter: anything below $201/night.
    match: r => Number.isFinite(r.nightly) && r.nightly < 201,
  },
  rentalStorePoints: {
    title: "DVC Rental Store under $12 per point",
    interval: "1 minute",
    priceChanges: true,
    match: r => Number.isFinite(r.pointPrice) && r.pointPrice < 12,
  },
  rentalStoreAll: {
    title: "DVC Rental Store - All Reservations",
    interval: "10 minutes",
    priceChanges: true,
    match: () => true,
  },
  davids: {
    title: "David's Vacation Rentals",
    interval: "10 minutes",
    priceChanges: true,
    match: r => (Number.isFinite(r.nightly) && r.nightly < 300) ||
      (/(?:one|two|three|1|2|3)[ -]?bedroom/i.test(r.room || "") && Number.isFinite(r.pointPrice) && r.pointPrice < 17),
  },
  dvcRental: {
    title: "DVC-Rental New Confirmed Reservations",
    interval: "10 minutes",
    priceChanges: false,
    match: () => true,
  },
  dvcShop: {
    title: "DVC Shop",
    interval: "10 minutes",
    priceChanges: false,
    match: r => !r.status || /available/i.test(r.status),
  },
};

export const EMAIL_LIMITS = {
  providerDaily: 300,
  warningAt: 225,
  lowPriorityCutoff: 250,
  hardSafetyCutoff: 295,
};

export const SOURCE_EXPECTED_MINUTES = {
  "rental-store-api": 2,
  "rental-store-all": 12,
  "rental-store-website": 4,
  "rental-store-website-dispatch": 3,
  "davids": 15,
  "dvc-shop": 15,
  "dvc-rental": 20,
};
