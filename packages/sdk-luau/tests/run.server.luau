-- Runs the SDK specs when the test place starts, and prints a summary to Output.
-- `rojo serve test.project.json`, connect from Studio, press Play.

local ServerScriptService = game:GetService("ServerScriptService")

local GamePulse = require(ServerScriptService.GamePulse)
local specs = require(script.Parent["GamePulse.spec"])(GamePulse)

local passed, failed = 0, 0
for _, spec in specs do
	local ok, err = pcall(spec.fn)
	if ok then
		passed += 1
		print(`  ok    {spec.name}`)
	else
		failed += 1
		warn(`  FAIL  {spec.name}\n        {err}`)
	end
end
print(`[GamePulse specs] {passed} passed, {failed} failed`)
