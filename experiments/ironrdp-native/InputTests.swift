import AppKit

@main
struct InputTests {
    static func main() {
        var wheel = WheelAccumulator()
        precondition(wheel.steps(delta: 0.1, precise: true).isEmpty)
        precondition(wheel.steps(delta: 0.1, precise: true).isEmpty)
        precondition(wheel.steps(delta: 0.1, precise: true).isEmpty)
        precondition(wheel.steps(delta: 0.1, precise: true) == [1])
        precondition(wheel.steps(delta: -0.1, precise: true).isEmpty)
        precondition(abs(wheel.remainder + 0.3) < 0.00001)
        precondition(wheel.steps(delta: -1, precise: true) == [-3])
        wheel = WheelAccumulator()
        var total = 0
        for _ in 0..<100 { total += wheel.steps(delta: 0.1, precise: true).reduce(0, +) }
        precondition(abs(Double(total) + wheel.remainder - 30) < 0.00001)
        precondition(wheel.steps(delta: 0, precise: true).isEmpty)
        wheel = WheelAccumulator()
        precondition(wheel.steps(delta: 3, precise: false) == [255, 105])
        precondition(wheel.steps(delta: -1, precise: false) == [-120])
        precondition(wheel.steps(delta: -200, precise: true) == [-255, -255, -90])
        print("PASS: precise wheel accumulation, fractional movement, reversal and discrete multi-notch input")
    }
}
