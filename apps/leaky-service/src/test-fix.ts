import { handleList } from "./server";

// Mock request object
const mockRequest = {
  url: "http://localhost:3000/orders?since=last-week"
} as Request;

// Mock id
const mockId = "test-id";

// Test the handleList function directly
handleList(mockRequest, mockId).then(response => {
  console.log("Status:", response.status);
  return response.json();
}).then(data => {
  console.log("Response:", data);
}).catch(err => {
  console.error("Error:", err);
});