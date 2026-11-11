
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const app = express();

app.use(express.json({ limit: "10kb" }));

const PORT = process.env.PORT || 3000;

const RESTAURANT_ADDRESS =
    "22A Sretenska Street, Poltava, Ukraine";

const NOMINATIM_URL =
    "https://nominatim.openstreetmap.org/search";

const OSRM_URL =
    "https://router.project-osrm.org/route/v1/driving";

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(origin => origin.trim())
    .filter(Boolean);

app.use(cors({
    origin(origin, callback) {
        if (!origin || allowedOrigins.length === 0 ||
            allowedOrigins.includes(origin)) {
            return callback(null, true);
        }

        return callback(new Error("Origin not allowed"));
    }
}));

app.use("/api/", rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false
}));

const cache = new Map();

async function geocode(address) {
    if (cache.has(address)) {
        return cache.get(address);
    }

    const url = new URL(NOMINATIM_URL);
    url.searchParams.set("q", address);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("limit", "1");
    url.searchParams.set("country", "Ukraine");
    url.searchParams.set("city", "Poltava");

    const response = await fetch(url, {
        headers: {
            "User-Agent": "FeelingHappyDeliveryAPI/1.0"
        }
    });

    if (!response.ok) {
        throw new Error("Geocoding service unavailable");
    }

    const results = await response.json();

    if (!results.length) {
        return null;
    }

    const result = results[0];
    const details = result.address || {};

    const city = (
        details.city ||
        details.town ||
        details.municipality ||
        details.village ||
        ""
    ).toLowerCase();

    if (
        details.country_code !== "ua" ||
        !city.includes("poltava")
    ) {
        return null;
    }

    const point = {
        lat: Number(result.lat),
        lon: Number(result.lon)
    };

    if (!Number.isFinite(point.lat) ||
        !Number.isFinite(point.lon)) {
        return null;
    }

    cache.set(address, point);

    return point;
}

let restaurantPointPromise = null;

function getRestaurantPoint() {
    if (!restaurantPointPromise) {
        restaurantPointPromise = geocode(RESTAURANT_ADDRESS);
    }

    return restaurantPointPromise;
}

async function getDrivingDistance(from, to) {
    const url =
        `${OSRM_URL}/${from.lon},${from.lat};${to.lon},${to.lat}` +
        "?overview=false";

    const response = await fetch(url);

    if (!response.ok) {
        throw new Error("Routing service unavailable");
    }

    const data = await response.json();

    if (
        data.code !== "Ok" ||
        !data.routes ||
        !data.routes.length
    ) {
        throw new Error("Route not found");
    }

    return data.routes[0].distance / 1000;
}

function calculateDelivery(distance, subtotal) {
    if (subtotal < 200) {
        return {
            allowed: false,
            error: "Мінімальне замовлення — 200 ₴"
        };
    }

    if (distance > 12) {
        return {
            allowed: false,
            error: "Адреса поза зоною доставки"
        };
    }

    let zone;
    let fee;

    if (distance <= 5) {
        zone = "До 5 км";
        fee = 105;
    } else if (distance <= 7) {
        zone = "Від 5 до 7 км";
        fee = 115;
    } else {
        zone = "Від 7 до 12 км";
        fee = 125;
    }

    const freeDelivery = subtotal >= 1000;

    if (freeDelivery) {
        fee = 0;
    }

    return {
        allowed: true,
        zone,
        fee,
        freeDelivery,
        total: subtotal + fee
    };
}

app.get("/health", (req, res) => {
    res.json({ status: "ok" });
});

app.post("/api/delivery/quote", async (req, res) => {
    try {
        const body = req.body || {};

        const forbiddenFields = [
            "distance",
            "distanceKm",
            "zone",
            "fee",
            "deliveryFee"
        ];

        if (forbiddenFields.some(field =>
            Object.prototype.hasOwnProperty.call(body, field)
        )) {
            return res.status(400).json({
                error: "Не можна передавати відстань або тариф вручну"
            });
        }

        const { address, subtotal } = body;

        if (
            typeof address !== "string" ||
            address.trim().length < 5 ||
            address.trim().length > 200
        ) {
            return res.status(400).json({
                error: "Вкажіть правильну адресу"
            });
        }

        if (
            typeof subtotal !== "number" ||
            !Number.isFinite(subtotal) ||
            subtotal < 0 ||
            subtotal > 100000
        ) {
            return res.status(400).json({
                error: "Неправильна сума замовлення"
            });
        }

        const destination = await geocode(
            `${address.trim()}, Poltava, Ukraine`
        );

        if (!destination) {
            return res.status(400).json({
                error: "Не вдалося знайти адресу в Полтаві"
            });
        }

        const origin = await getRestaurantPoint();

        if (!origin) {
            throw new Error("Restaurant address unavailable");
        }

        const distance = await getDrivingDistance(
            origin,
            destination
        );

        const result = calculateDelivery(distance, subtotal);

        if (!result.allowed) {
            return res.status(400).json({
                error: result.error,
                distanceKm: Number(distance.toFixed(2))
            });
        }

        return res.json({
            distanceKm: Number(distance.toFixed(2)),
            zone: result.zone,
            deliveryFee: result.fee,
            freeDelivery: result.freeDelivery,
            subtotal,
            total: result.total
        });

    } catch (error) {
        console.error("Delivery quote error:", error.message);

        return res.status(503).json({
            error: "Не вдалося розрахувати доставку. Спробуйте пізніше."
        });
    }
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Feeling Happy API running on port ${PORT}`);
});
