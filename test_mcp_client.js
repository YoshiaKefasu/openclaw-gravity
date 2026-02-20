import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"

async function runTest() {
	console.log("Connecting to MCP Server via SSE...")
	const transport = new SSEClientTransport(new URL("http://127.0.0.1:3000/sse"))
	const client = new Client(
		{ name: "test-client", version: "1.0.0" },
		{ capabilities: {} },
	)

	await client.connect(transport)
	console.log("✅ Connected!")

	console.log("\n--- Testing ag_get_status ---")
	let status = await client.callTool({ name: "ag_get_status", arguments: {} })
	console.log(status.content[0].text)

	console.log("\n--- Testing ag_check_approval_required ---")
	let approval = await client.callTool({
		name: "ag_check_approval_required",
		arguments: {},
	})
	console.log(approval.content[0].text)

	console.log("\n--- Testing ag_send_message with Attachment ---")
	const tinyPngBase64 =
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
	let sendRes = await client.callTool({
		name: "ag_send_message",
		arguments: {
			text: "Hello from MCP Client! Here is a tiny image attachment test.",
			attachments: [
				{
					name: "test_image.png",
					mimeType: "image/png",
					data: tinyPngBase64,
				},
			],
		},
	})
	console.log(sendRes.content[0].text)

	console.log("\n--- Testing ag_get_last_response ---")
	let lastRes = await client.callTool({ name: "ag_get_last_response", arguments: {} })
	console.log(JSON.parse(lastRes.content[0].text).text?.substring(0, 100))

	// Cleanup
	process.exit(0)
}

runTest().catch(console.error)
