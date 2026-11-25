// The picture at the top of The Loop's share dialog, after the invite card
// the person chose: a spotlight falls on two phones; Lasso's 3D mascot pops
// onto each, hearts drift up from them, and a glowing link appears between
// them, leaving a few rays and a sparkle. It plays once as the step opens and
// then breathes gently.

import Cocoa
import SwiftUI

/// The share dialog's colours: deep indigo under a cool spotlight.
enum LoopShareLook {
    static let top = LoopLook.rgb(0x2C2F8A)
    static let middle = LoopLook.rgb(0x4044A8)
    static let bottom = LoopLook.rgb(0x1B1E57)
    static let light = LoopLook.rgb(0xCFEBFF)
    static let lavender = LoopLook.rgb(0xB9B9F2)
    static let ink = Color.white
    static let ink2 = LoopLook.rgb(0xD9DAFF, 0.72)
    static let ink3 = LoopLook.rgb(0xD9DAFF, 0.5)
    static let field = Color.white.opacity(0.1)
    static let chip = Color.white.opacity(0.08)
    static let button = LoopLook.rgb(0xF2F3FF)
    static let onButton = LoopLook.rgb(0x15174A)
}

struct LoopShareScene: View {
    @State private var start = Date()
    private let still = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    static let size = CGSize(width: 440, height: 230)

    var body: some View {
        TimelineView(.animation(paused: still)) { context in
            let time = LoopDemoTime(t: still ? 4 : context.date.timeIntervalSince(start), loop: .infinity)
            ZStack(alignment: .topLeading) {
                spotlight
                phone(lean: -13).position(x: 150, y: 150)
                phone(lean: 13).position(x: 290, y: 150)
                hearts(time)
                badge(time)
            }
            .frame(width: Self.size.width, height: Self.size.height)
        }
        // The mascots draw themselves, outside the clock: each pops in once and then follows the pointer.
        .overlay(alignment: .topLeading) {
            LoopMascot3D(look: (.sky, .happy), entrance: 0.35)
                .frame(width: 104, height: 104)
                .offset(x: 128, y: 60)
            LoopMascot3D(look: (.rope, .happy), entrance: 0.55)
                .frame(width: 104, height: 104)
                .offset(x: 208, y: 60)
        }
        .frame(width: Self.size.width, height: Self.size.height)
        .clipped()
        .accessibilityHidden(true)
    }

    /// A cone of cool light from the top, and a lighter band where the phones stand.
    private var spotlight: some View {
        ZStack {
            RadialGradient(colors: [LoopShareLook.light.opacity(0.95), LoopShareLook.lavender.opacity(0.45), .clear],
                           center: UnitPoint(x: 0.5, y: -0.05), startRadius: 4, endRadius: 190)
                .scaleEffect(x: 0.9, y: 1.25, anchor: .top)
            LinearGradient(colors: [.clear, LoopShareLook.lavender.opacity(0.22), .clear],
                           startPoint: UnitPoint(x: 0.5, y: 0.62), endPoint: UnitPoint(x: 0.5, y: 0.98))
        }
        .frame(width: Self.size.width, height: Self.size.height)
        .allowsHitTesting(false)
    }

    /// A phone standing at a lean, its screen catching the light.
    private func phone(lean: Double) -> some View {
        ZStack(alignment: .top) {
            RoundedRectangle(cornerRadius: 15, style: .continuous)
                .fill(LinearGradient(colors: [LoopLook.rgb(0xE9E9F6), LoopLook.rgb(0xA4A5C8)], startPoint: .top, endPoint: .bottom))
            RoundedRectangle(cornerRadius: 15, style: .continuous)
                .strokeBorder(Color.black, lineWidth: 4)
            Capsule().fill(Color.black).frame(width: 22, height: 5).padding(.top, 6)
        }
        .frame(width: 76, height: 140)
        .shadow(color: .black.opacity(0.35), radius: 10, y: 6)
        .rotationEffect(.degrees(lean))
    }

    /// Little hearts that drift up from each mascot and hang there, bobbing.
    private func hearts(_ time: LoopDemoTime) -> some View {
        let drifting: [(x: CGFloat, y: CGFloat, size: CGFloat, color: Color, at: Double)] = [
            (122, 150, 15, LoopLook.rgb(0x7884FF), 1.0), (196, 66, 13, LoopLook.rgb(0x8E97FF), 1.2),
            (318, 156, 16, Color.white.opacity(0.9), 1.1), (246, 62, 12, Color.white.opacity(0.8), 1.35),
        ]
        return ZStack(alignment: .topLeading) {
            ForEach(Array(drifting.enumerated()), id: \.offset) { index, heart in
                let shown = time.ramp(heart.at, heart.at + 0.5, curve: .back)
                let rise = 22 * CGFloat(time.ramp(heart.at, heart.at + 1.2, curve: .out))
                let bob = 3 * CGFloat(sin(time.t * 1.8 + Double(index)))
                Image(systemName: "heart.fill")
                    .font(.system(size: heart.size))
                    .foregroundStyle(heart.color)
                    .shadow(color: heart.color.opacity(0.6), radius: 6)
                    .scaleEffect(shown)
                    .opacity(min(1, shown))
                    .position(x: heart.x, y: heart.y - rise + (time.t > heart.at + 1.2 ? bob : 0))
            }
        }
    }

    /// A glowing link between the two that swells and fades, leaving rays and a sparkle.
    private func badge(_ time: LoopDemoTime) -> some View {
        let glow = time.span(1.5, 2.6, edge: 0.3)
        let pop = time.ramp(1.5, 1.85, curve: .back)
        let rays = time.ramp(1.8, 2.3, curve: .out)
        return ZStack {
            Circle().fill(Color.white.opacity(0.9)).frame(width: 80, height: 80).blur(radius: 24).opacity(glow)
            ZStack {
                Circle().fill(RadialGradient(colors: [Color.white, LoopShareLook.light], center: .center, startRadius: 2, endRadius: 30))
                Circle().strokeBorder(Color.white, lineWidth: 2)
                LoopLucideIcon(icon: .link, size: 22, color: LoopLook.rgb(0x4F5BEF))
            }
            .frame(width: 54, height: 54)
            .scaleEffect(pop)
            .opacity(glow)
            ForEach(0..<5, id: \.self) { ray in
                Capsule().fill(Color.white.opacity(0.75))
                    .frame(width: 2.5, height: 9)
                    .offset(y: -42)
                    .rotationEffect(.degrees(Double(ray - 2) * 22))
                    .opacity(rays * (time.t > 2.6 ? 0.85 : 1))
            }
            Image(systemName: "sparkle").font(.system(size: 13, weight: .bold)).foregroundStyle(Color.white)
                .offset(x: 46, y: -40)
                .scaleEffect(rays)
                .opacity(rays * (0.75 + 0.25 * sin(time.t * 2.4)))
        }
        .position(x: 220, y: 62)
    }
}
