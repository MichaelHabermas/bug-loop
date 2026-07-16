import { handleRequest } from "./src/server";

async function testMalformedJson() {
  const response = await handleRequest(
    new Request("http://leaky-service.test/orders/import", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{not-json",
    }),
  );
  
  console.log("Status:", response.status);
  console.log("Body:", await response.text());
}

testMalformedJson().catch(console.error);