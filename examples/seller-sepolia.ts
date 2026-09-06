import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";

const payTo = process.env.PAY_TO as `0x${string}`; // any address you control; can be the buyer wallet's own address
const facilitator = new HTTPFacilitatorClient({
	url: "https://x402.org/facilitator",
});

const app = express();
app.use(
	paymentMiddleware(
		{
			"GET /weather": {
				accepts: [
					{ scheme: "exact", price: "$0.01", network: "eip155:84532", payTo },
				],
				description: "Weather data",
				mimeType: "application/json",
			},
		},
		new x402ResourceServer(facilitator).register(
			"eip155:84532",
			new ExactEvmScheme(),
		),
	),
);
app.get("/weather", (_req, res) => res.json({ weather: "sunny", temp: 72 }));
app.listen(4021, () => console.log("seller on :4021"));
