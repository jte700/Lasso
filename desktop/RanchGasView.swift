// The gas behind The Ranch's opening: slow green smoke drawn by the graphics
// card. When the person begins it thins from the middle and spreads off the
// window, and what is under it shows through. Where there is no graphics card
// to draw it, a still wash of the same greens stands in.

import Cocoa
import MetalKit
import SwiftUI

struct RanchGasView: NSViewRepresentable {
    /// 0 is the gas at rest, filling the window; 1 is all of it gone.
    var disperse: Double

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSView {
        guard let renderer = RanchGasRenderer() else { return RanchGasStill() }
        context.coordinator.renderer = renderer
        let view = MTKView(frame: .zero, device: renderer.device)
        view.delegate = renderer
        view.colorPixelFormat = .bgra8Unorm
        view.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
        view.framebufferOnly = true
        view.preferredFramesPerSecond = 60
        // The smoke is soft, so it is drawn at one pixel per point and stretched.
        view.autoResizeDrawable = false
        view.layer?.isOpaque = false
        renderer.target = Float(disperse)
        renderer.jump()
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {
        if let still = view as? RanchGasStill { still.alphaValue = CGFloat(1 - disperse) }
        guard let renderer = context.coordinator.renderer, let view = view as? MTKView else { return }
        renderer.target = Float(disperse)
        view.isPaused = false
    }

    final class Coordinator {
        var renderer: RanchGasRenderer?
    }
}

/// The same greens, still, for a Mac that cannot draw the moving gas.
private final class RanchGasStill: NSView {
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        let wash = CAGradientLayer()
        wash.type = .radial
        wash.colors = [NSColor(srgbRed: 0.24, green: 0.56, blue: 0.34, alpha: 1).cgColor,
                       NSColor(srgbRed: 0.02, green: 0.22, blue: 0.14, alpha: 1).cgColor,
                       NSColor(srgbRed: 0.01, green: 0.12, blue: 0.08, alpha: 1).cgColor]
        wash.locations = [0, 0.55, 1]
        wash.startPoint = CGPoint(x: 0.72, y: 0.3)
        wash.endPoint = CGPoint(x: 1.5, y: 1.3)
        wash.autoresizingMask = [.layerWidthSizable, .layerHeightSizable]
        layer?.addSublayer(wash)
    }

    required init?(coder: NSCoder) { nil }

    override func layout() {
        super.layout()
        layer?.sublayers?.first?.frame = bounds
    }
}

final class RanchGasRenderer: NSObject, MTKViewDelegate {
    /// What the shader is told each frame; the layout matches `GasUniforms` below.
    private struct Uniforms {
        var size: SIMD2<Float> = .zero
        var pointer = SIMD2<Float>(0.5, 0.5)
        var time: Float = 0
        var disperse: Float = 0
        var near: Float = 0
        var grain: Float = 0.03
    }

    let device: MTLDevice
    private let queue: MTLCommandQueue
    private let pipeline: MTLRenderPipelineState
    /// Where the dispersal is headed; the gas eases toward it on its own.
    var target: Float = 0
    private var shown: Float = 0
    private var speed: Float = 0
    private var uniforms = Uniforms()
    private var last = CACurrentMediaTime()
    /// The pattern is well developed from the first frame.
    private var clock: Double = 37
    private let still = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion

    init?(device: MTLDevice? = MTLCreateSystemDefaultDevice()) {
        guard let device, let queue = device.makeCommandQueue(),
              let library = try? device.makeLibrary(source: Self.source, options: nil) else { return nil }
        let descriptor = MTLRenderPipelineDescriptor()
        descriptor.vertexFunction = library.makeFunction(name: "gas_vertex")
        descriptor.fragmentFunction = library.makeFunction(name: "gas_fragment")
        descriptor.colorAttachments[0].pixelFormat = .bgra8Unorm
        guard let pipeline = try? device.makeRenderPipelineState(descriptor: descriptor) else { return nil }
        self.device = device
        self.queue = queue
        self.pipeline = pipeline
    }

    /// Starts at the target, without easing to it.
    func jump() {
        shown = target
        speed = 0
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    func draw(in view: MTKView) {
        let now = CACurrentMediaTime()
        let step = Float(min(1.0 / 20, max(0, now - last)))
        last = now
        guard view.window?.occlusionState.contains(.visible) == true, view.bounds.width > 1, view.bounds.height > 1 else { return }
        let size = CGSize(width: view.bounds.width.rounded(), height: view.bounds.height.rounded())
        if view.drawableSize != size { view.drawableSize = size }
        if !still { clock += Double(step) }
        ease(step)
        follow(view, step: step)
        uniforms.size = SIMD2(Float(size.width), Float(size.height))
        uniforms.time = Float(clock)
        uniforms.disperse = min(1, max(0, shown))
        guard let pass = view.currentRenderPassDescriptor, let drawable = view.currentDrawable,
              let buffer = queue.makeCommandBuffer(),
              let encoder = buffer.makeRenderCommandEncoder(descriptor: pass) else { return }
        encoder.setRenderPipelineState(pipeline)
        encoder.setFragmentBytes(&uniforms, length: MemoryLayout<Uniforms>.stride, index: 0)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        encoder.endEncoding()
        buffer.present(drawable)
        buffer.commit()
        // Nothing is left to draw once all of it has gone.
        if target >= 1, shown >= 0.999 { view.isPaused = true }
    }

    /// A spring with no bounce: the gas gathers speed, then settles.
    private func ease(_ step: Float) {
        let pace: Float = 3.4
        let gap = shown - target
        speed += (-pace * pace * gap - 2 * pace * speed) * step
        shown += speed * step
        if abs(gap) < 0.0005, abs(speed) < 0.0005 { shown = target; speed = 0 }
    }

    /// The gas leans toward the pointer while it is over the window.
    private func follow(_ view: MTKView, step: Float) {
        guard let window = view.window else { return }
        let place = view.convert(window.convertPoint(fromScreen: NSEvent.mouseLocation), from: nil)
        let inside = view.bounds.contains(place) && window.isKeyWindow
        let aim = SIMD2(Float(place.x / view.bounds.width), Float(1 - place.y / view.bounds.height))
        if inside { uniforms.pointer += (aim - uniforms.pointer) * min(1, step * 3) }
        uniforms.near += ((inside ? 1 : 0) - uniforms.near) * min(1, step * 2.4)
    }

    private static let source = """
    #include <metal_stdlib>
    using namespace metal;

    struct GasUniforms {
        float2 size;
        float2 pointer;
        float time;
        float disperse;
        float near;
        float grain;
    };

    struct GasVertex {
        float4 position [[position]];
    };

    // One triangle that covers the whole view.
    vertex GasVertex gas_vertex(uint id [[vertex_id]]) {
        float2 corner = float2(float((id << 1) & 2), float(id & 2));
        GasVertex out;
        out.position = float4(corner * 2.0 - 1.0, 0.0, 1.0);
        return out;
    }

    static float gas_hash(float2 p) {
        return fract(sin(dot(p, float2(41.3, 289.1))) * 45758.5453);
    }

    static float gas_noise(float2 p) {
        float2 cell = floor(p);
        float2 f = p - cell;
        float2 s = f * f * (3.0 - 2.0 * f);
        float a = gas_hash(cell);
        float b = gas_hash(cell + float2(1.0, 0.0));
        float c = gas_hash(cell + float2(0.0, 1.0));
        float d = gas_hash(cell + float2(1.0, 1.0));
        return mix(mix(a, b, s.x), mix(c, d, s.x), s.y);
    }

    // Five layers of noise, each finer, fainter and turned a little against the last.
    static float gas_cloud(float2 p) {
        const float2x2 turn = float2x2(float2(0.8, 0.6), float2(-0.6, 0.8));
        float sum = 0.0;
        float gain = 0.5;
        for (int layer = 0; layer < 5; layer++) {
            sum += gain * gas_noise(p);
            p = turn * p * 2.02 + float2(3.1, 7.7);
            gain *= 0.5;
        }
        return sum;
    }

    // Deep green in the folds, through forest, moss and leaf, to a pale mint on the crests.
    static float3 gas_colour(float t) {
        const float3 ink = float3(0.008, 0.118, 0.078);
        const float3 forest = float3(0.024, 0.224, 0.137);
        const float3 moss = float3(0.086, 0.380, 0.227);
        const float3 leaf = float3(0.243, 0.557, 0.341);
        const float3 mint = float3(0.494, 0.745, 0.545);
        const float3 pale = float3(0.749, 0.878, 0.733);
        float3 c = mix(ink, forest, smoothstep(0.08, 0.32, t));
        c = mix(c, moss, smoothstep(0.32, 0.52, t));
        c = mix(c, leaf, smoothstep(0.52, 0.69, t));
        c = mix(c, mint, smoothstep(0.69, 0.84, t));
        return mix(c, pale, smoothstep(0.84, 0.98, t));
    }

    fragment float4 gas_fragment(GasVertex in [[stage_in]], constant GasUniforms &u [[buffer(0)]]) {
        float2 uv = in.position.xy / u.size;
        float aspect = u.size.x / u.size.y;
        float2 centred = (uv - 0.5) * float2(aspect, 1.0);
        float gone = u.disperse;

        // Dispersing, the gas spreads: what was near the middle is carried outward.
        float2 p = centred * 0.56 * (1.0 - 0.42 * gone);
        float t = u.time * 0.045 + gone * 0.9;

        float2 toPointer = ((u.pointer - 0.5) * float2(aspect, 1.0) - centred) * 0.56;
        float pull = exp(-dot(toPointer, toPointer) * 13.0) * u.near * (1.0 - gone);

        // Noise bent by noise, twice over, which is what makes it billow.
        float2 first = float2(gas_cloud(p * 2.1 + float2(t, -0.6 * t)),
                              gas_cloud(p * 2.1 + float2(4.7, 1.9) - 0.8 * t));
        float2 second = float2(gas_cloud(p * 1.7 + 1.9 * first + float2(2.3, 8.1) + 1.2 * t),
                               gas_cloud(p * 1.7 + 1.9 * first + float2(7.9, 3.4) - t));
        second += toPointer * pull * 1.3;
        float body = gas_cloud(p * 1.6 + 2.0 * second);

        float swell = 0.11 * sin(p.x * 5.0 - p.y * 3.2 + t * 9.0 + body * 5.0);
        float tone = clamp(body * 1.25 - 0.08 + swell + pull * 0.3, 0.0, 1.0);
        float3 colour = gas_colour(tone);
        // A warm shadow in the deepest folds.
        colour = mix(colour, float3(0.13, 0.06, 0.05), smoothstep(0.62, 0.86, first.x) * (1.0 - tone) * 0.4);
        colour *= 1.0 - u.grain + 2.0 * u.grain * gas_hash(in.position.xy + floor(u.time * 24.0));

        // What is left of it here: a ragged clearing opens from the middle and
        // runs out to the corners, the thin parts going before the thick.
        float reach = length(centred) / length(float2(aspect, 1.0) * 0.5);
        float front = gone * 2.0 - 0.5;
        float left = smoothstep(front - 0.5, front + 0.05, reach + (body - 0.5) * 0.7);
        left *= mix(1.0, smoothstep(0.22, 0.7, tone), gone);
        left *= 1.0 - smoothstep(0.72, 1.0, gone);
        return float4(colour * left, left);
    }
    """
}
