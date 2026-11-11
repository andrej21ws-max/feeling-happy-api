
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

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

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
    if (cache.has(address)) {
        return cache.get(address);
    }

    const url = new URL(
        "https://nominatim.openstreetmap.org/search"
    );

    url.searchParams.set(
        "q",
        address + ", Полтава, Україна"
    );
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "1");
    url.searchParams.set("countrycodes", "ua");

    const response = await fetch(url, {
        headers: {
            "User-Agent": "FeelingHappyDelivery/1.0"
        }
    });

    if (!response.ok) {
        throw new Error("Geocoding unavailable");
    }

    const results = await response.json();

    if (!results.length) return null;

    const point = {
        lat: Number(results[0].lat),
        lon: Number(results[0].lon)
    };

    if (
        point.lat < 49.50 || point.lat > 49.70 ||
        point.lon < 34.40 || point.lon > 34.70
    ) {
        return null;
    }

    cache.set(address, point);

    return point;
}

async function getDistance(destination) {
    const url =
        "https://router.project-osrm.org/route/v1/driving/" +
        `${RESTAURANT.lon},${RESTAURANT.lat};` +
        `${destination.lon},${destination.lat}?overview=false`;

    const response = await fetch(url);

    if (!response.ok) {
        throw new Error("Routing unavailable");
    }

    const data = await response.json();

    if (data.code !== "Ok" || !data.routes?.length) {
        throw new Error("Route not found");
    }

    return data.routes[0].distance / 1000;
}

function calculateDelivery(distance, subtotal) {
    if (subtotal < 200) {
        return {
            error: "Мінімальне замовлення — 200 ₴"
        };
    }

    if (distance > 12) {
        return {
            error: "Адреса поза зоною доставки"
        };
    }

    let fee = distance <= 5 ? 105 :
              distance <= 7 ? 115 : 125;

    if (subtotal >= 1000) {
        fee = 0;
    }

    return {
        deliveryFee: fee,
        total: subtotal + fee
    };
}

// Перевірка роботи сервера
app.get("/health", (req, res) => {
    res.json({
        status: "ok"
    });
});

// Розрахунок доставки
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

        const result = calculateDelivery(
            distance,
            subtotal
        );

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

// Відправлення замовлення в Telegram
app.post("/api/order", async (req, res) => {
    try {
        if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
            return res.status(503).json({
                error: "Telegram ще не налаштований"
            });
        }

        const {
            customerName,
            phone,
            address,
            items,
            comment
        } = req.body || {};

        if (
            typeof customerName !== "string" ||
            customerName.trim().length < 2 ||
            customerName.trim().length > 80
        ) {
            return res.status(400).json({
                error: "Вкажіть ім'я"
            });
        }

        if (
            typeof phone !== "string" ||
            phone.trim().length < 7 ||
            phone.trim().length > 25
        ) {
            return res.status(400).json({
                error: "Вкажіть правильний номер телефону"
            });
        }

        if (
            typeof address !== "string" ||
            address.trim().length < 5 ||
            address.trim().length > 200
        ) {
            return res.status(400).json({
                error: "Вкажіть адресу доставки"
            });
        }

        if (
            !Array.isArray(items) ||
            items.length === 0 ||
            items.length > 30
        ) {
            return res.status(400).json({
                error: "Кошик порожній або містить забагато товарів"
            });
        }

        let subtotal = 0;

        const orderItems = [];

        for (const item of items) {
            if (
                typeof item.name !== "string" ||
                item.name.trim().length === 0 ||
                item.name.length > 100 ||
                !Number.isSafeInteger(item.quantity) ||
                item.quantity < 1 ||
                item.quantity > 99 ||
                typeof item.price !== "number" ||
                !Number.isFinite(item.price) ||
                item.price <= 0 ||
                item.price > 100000
            ) {
                return res.status(400).json({
                    error: "Некоректні дані товару"
                });
            }

            subtotal += item.price * item.quantity;

            orderItems.push(
                `${item.name} — ${item.quantity} шт. × ${item.price} ₴`
            );
        }

        if (subtotal < 200) {
            return res.status(400).json({
                error: "Мінімальне замовлення — 200 ₴"
            });
        }

        if (subtotal > 100000) {
            return res.status(400).json({
                error: "Занадто велика сума замовлення"
            });
        }

        const destination = await geocode(address.trim());

        if (!destination) {
            return res.status(400).json({
                error: "Не вдалося знайти адресу в Полтаві"
            });
        }

        const distance = await getDistance(destination);

        const delivery = calculateDelivery(
            distance,
            subtotal
        );

        if (delivery.error) {
            return res.status(400).json({
                error: delivery.error
            });
        }

        const safeComment =
            typeof comment === "string"
                ? comment.trim().slice(0, 500)
                : "";

        const message = [
            "🛎 НОВЕ ЗАМОВЛЕННЯ — FEELING HAPPY",
            "",
            `👤 Ім'я: ${customerName.trim()}`,
            `📞 Телефон: ${phone.trim()}`,
            `📍 Адреса: ${address.trim()}`,
            "",
            "🛒 ЗАМОВЛЕННЯ:",
            ...orderItems,
            "",
            `📏 Відстань: ${distance.toFixed(2)} км`,
            `💰 Сума товарів: ${subtotal} ₴`,
            `🚗 Доставка: ${delivery.deliveryFee === 0 ? "Безкоштовно" : delivery.deliveryFee + " ₴"}`,
            `💳 РАЗОМ: ${delivery.total} ₴`,
            "",
            safeComment ? `📝 Коментар: ${safeComment}` : ""
        ].filter(Boolean).join("\n");

        const telegramResponse = await fetch(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    chat_id: TELEGRAM_CHAT_ID,
                    text: message
                })
            }
        );

        const telegramResult = await telegramResponse.json();

        if (!telegramResponse.ok || !telegramResult.ok) {
            console.error(
                "Telegram error:",
                telegramResult.description || "Unknown error"
            );

            return res.status(502).json({
                error: "Не вдалося відправити замовлення в Telegram"
            });
        }

        res.json({
            success: true,
            message: "Замовлення успішно відправлено!",
            subtotal,
            deliveryFee: delivery.deliveryFee,
            distanceKm: Number(distance.toFixed(2)),
            total: delivery.total
        });

    } catch (error) {
        console.error("Order error:", error);

        res.status(503).json({
            error: "Не вдалося оформити замовлення. Спробуйте пізніше."
        });
    }
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(
        `Feeling Happy API running on port ${PORT}`
    );
});
