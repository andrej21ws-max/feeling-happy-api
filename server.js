
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "10kb" }));

const RESTAURANT = {
    lat: 49.5864663,
    lon: 34.5601613
};

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(origin => origin.trim())
    .filter(Boolean);

app.use(cors({
    origin(origin, callback) {
        if (!origin || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        callback(new Error("Origin not allowed"));
    }
}));

app.use("/api/", rateLimit({
    windowMs: 60 * 1000,
    limit: 20
}));

const cache = new Map();

async function geocode(address) {
    if (cache.has(address)) return cache.get(address);

    const url = new URL(
        "https://nominatim.openstreetmap.org/search"
    );

    url.searchParams.set("q", address + ", Полтава, Україна");
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "1");
    url.searchParams.set("countrycodes", "ua");

    const response = await fetch(url, {
        headers: {
            "User-Agent": "FeelingHappyDelivery/1.0"
        }
    });

    if (!response.ok) throw new Error("Geocoding unavailable");

    const results = await response.json();
    if (!results.length) return null;

    const point = {
        lat: Number(results[0].lat),
        lon: Number(results[0].lon)
    };

    if (
        point.lat < 49.50 || point.lat > 49.70 ||
        point.lon < 34.40 || point.lon > 34.70
    ) return null;

    cache.set(address, point);
    return point;
}

async function getDistance(destination) {
    const url =
        "https://router.project-osrm.org/route/v1/driving/" +
        `${RESTAURANT.lon},${RESTAURANT.lat};` +
        `${destination.lon},${destination.lat}?overview=false`;

    const response = await fetch(url);
    if (!response.ok) throw new Error("Routing unavailable");

    const data = await response.json();

    if (data.code !== "Ok" || !data.routes?.length) {
        throw new Error("Route not found");
    }

    return data.routes[0].distance / 1000;
}

function calculateDelivery(distance, subtotal) {
    if (subtotal < 200) {
        return { error: "Мінімальне замовлення — 200 ₴" };
    }

    if (distance > 12) {
        return { error: "Адреса поза зоною доставки" };
    }

    let fee = distance <= 5 ? 105 :
              distance <= 7 ? 115 : 125;

    if (subtotal >= 1000) fee = 0;

    return {
        deliveryFee: fee,
        total: subtotal + fee
    };
}

app.get("/health", (req, res) => {
    res.json({ status: "ok" });
});

app.post("/api/delivery/quote", async (req, res) => {
    try {
        const { address, subtotal } = req.body || {};

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

        const destination = await geocode(address.trim());

        if (!destination) {
            return res.status(400).json({
                error: "Не вдалося знайти адресу в Полтаві"
            });
        }

        const distance = await getDistance(destination);
        const result = calculateDelivery(distance, subtotal);

        if (result.error) {
            return res.status(400).json({
                error: result.error,
                distanceKm: Number(distance.toFixed(2))
            });
        }

        res.json({
            distanceKm: Number(distance.toFixed(2)),
            deliveryFee: result.deliveryFee,
            subtotal,
            total: result.total
        });

    } catch (error) {
        console.error(error);

        res.status(503).json({
            error: "Не вдалося розрахувати доставку. Спробуйте пізніше."
        });
    }
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Feeling Happy API running on port ${PORT}`);
});
