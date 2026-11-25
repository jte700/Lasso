// The tour's live demos, drawn on a fixed 400 by 250 canvas that is scaled
// to the card, and worked out frame by frame from the moment in their loop
// (LoopDemoTime). This file holds the pieces they share and the folders
// demo; writing and sharing are in LoopTourWritingDemos.swift, and the
// welcome's 3D mascot in LoopMascot3D.swift.

import Cocoa
import SwiftUI

struct LoopTourDemo: View {
    let step: LoopTourStep
    let time: LoopDemoTime
    static let canvas = CGSize(width: 400, height: 250)

    var body: some View {
        GeometryReader { geometry in
            let scale = min(geometry.size.width / Self.canvas.width, geometry.size.height / Self.canvas.height)
            content
                .frame(width: Self.canvas.width, height: Self.canvas.height)
                .scaleEffect(scale)
                .frame(width: geometry.size.width, height: geometry.size.height)
        }
        .environment(\.colorScheme, .light)
    }

    @ViewBuilder private var content: some View {
        switch step {
        case .welcome: Color.clear
        case .folders: LoopFoldersDemo(time: time).opacity(time.fade)
        case .autocomplete: LoopAutocompleteDemo(time: time).opacity(time.fade)
        case .share: LoopShareDemo(time: time).opacity(time.fade)
        }
    }
}

// MARK: Shared pieces

/// The arrow a demo is driven with, and a ring where it clicks.
struct LoopDemoPointer: View {
    let at: CGPoint
    /// The moments it clicks.
    let clicks: [Double]
    let time: LoopDemoTime
    var opacity: Double = 1

    var body: some View {
        ZStack(alignment: .topLeading) {
            ForEach(Array(clicks.enumerated()), id: \.offset) { _, click in
                let ring = time.ramp(click, click + 0.4, curve: .out)
                if ring > 0 && ring < 1 {
                    Circle().strokeBorder(LoopTourLook.blue.opacity(0.5 * (1 - ring)), lineWidth: 2)
                        .frame(width: 34, height: 34)
                        .scaleEffect(0.3 + ring)
                        .offset(x: -17, y: -17)
                }
            }
            LoopArrowShape()
                .fill(Color.black)
                .overlay(LoopArrowShape().stroke(Color.white, lineWidth: 1.4))
                .frame(width: 13, height: 19)
                .scaleEffect(clicks.contains { time.press($0, length: 0.14) > 0 } ? 0.86 : 1, anchor: .topLeading)
                .shadow(color: .black.opacity(0.25), radius: 2, y: 1)
        }
        .offset(x: at.x, y: at.y)
        .opacity(opacity)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .allowsHitTesting(false)
    }
}

/// The macOS arrow, its tip at the top left.
struct LoopArrowShape: Shape {
    func path(in rect: CGRect) -> Path {
        let w = rect.width, h = rect.height
        var path = Path()
        path.move(to: CGPoint(x: 0, y: 0))
        path.addLine(to: CGPoint(x: 0, y: h * 0.78))
        path.addLine(to: CGPoint(x: w * 0.3, y: h * 0.6))
        path.addLine(to: CGPoint(x: w * 0.5, y: h))
        path.addLine(to: CGPoint(x: w * 0.68, y: h * 0.92))
        path.addLine(to: CGPoint(x: w * 0.48, y: h * 0.53))
        path.addLine(to: CGPoint(x: w, y: h * 0.53))
        path.closeSubpath()
        return path
    }
}

/// A small app window: three dots, a title, and what it holds.
struct LoopDemoWindow<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                HStack(spacing: 5) {
                    ForEach([0xF26A5E, 0xF5BF4F, 0x62C554], id: \.self) { hex in
                        Circle().fill(LoopLook.rgb(hex)).frame(width: 7, height: 7)
                    }
                    Spacer()
                }
                Text(title).font(LoopLook.font(10.5, .medium)).foregroundStyle(LoopTourLook.ink3)
            }
            .padding(.horizontal, 10)
            .frame(height: 24)
            LoopTourLook.line.frame(height: 1)
            content.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .background(RoundedRectangle(cornerRadius: 11, style: .continuous).fill(Color.white))
        .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
        .shadow(color: .black.opacity(0.08), radius: 12, y: 5)
        .shadow(color: .black.opacity(0.06), radius: 1, y: 0.5)
    }
}

/// A key on a keyboard, pressed down at its moments.
struct LoopDemoKey: View {
    let label: String
    /// 0 up, 1 all the way down.
    let pressed: Double

    var body: some View {
        Text(label)
            .font(LoopLook.font(12, .medium))
            .foregroundStyle(LoopTourLook.ink)
            .frame(width: 54, height: 32)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.white))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(LoopTourLook.line, lineWidth: 1))
            .shadow(color: .black.opacity(0.18 * (1 - pressed * 0.7)), radius: 0, y: 3 - 2 * pressed)
            .offset(y: 2 * pressed)
            .scaleEffect(1 - 0.05 * pressed)
    }
}

/// A file as a chip: its type's icon and its name.
struct LoopDemoFileChip: View {
    let name: String

    var body: some View {
        HStack(spacing: 6) {
            LoopFileIcon(url: nil, fileExtension: (name as NSString).pathExtension, size: 14)
            Text(name).font(LoopLook.font(10.5, .medium)).foregroundStyle(LoopTourLook.ink).lineLimit(1)
        }
        .padding(.horizontal, 9)
        .frame(height: 26)
        .background(Capsule().fill(Color.white))
        .shadow(color: .black.opacity(0.08), radius: 6, y: 3)
        .fixedSize()
    }
}

/// Text widths in the demos' faces, for placing things after a run of text.
enum LoopDemoText {
    static func width(_ text: String, size: CGFloat, weight: LoopLook.Weight = .regular) -> CGFloat {
        ceil((text as NSString).size(withAttributes: [.font: LoopLook.nsFont(size, weight)]).width)
    }
}

// MARK: Choosing folders

/// Folders are ticked in a chooser and added; their files are read into the
/// library one after another until it is ready.
struct LoopFoldersDemo: View {
    let time: LoopDemoTime

    private static let folders: [(name: String, color: Color)] = [
        ("Harbor Bridge", LoopLook.rgb(0x4F8FD6)), ("Lease Review", LoopLook.rgb(0xD39A3F)),
        ("Field Notes", LoopLook.rgb(0x6E9A5C)), ("Site Photos", LoopLook.rgb(0xB06A54)),
    ]
    /// When each of the first three is ticked, and when Add is pressed.
    private static let ticks = [0.85, 1.45, 2.05]
    private static let add = 2.8
    private static let files = ["Span loads.xlsx", "Bearing detail.pdf", "Deck model.step", "Lease 4B.docx",
                                "Site plan.dxf", "Review.pptx"]
    private static let read = 3.1
    private static let ready = 6.9

    private var pointer: LoopDemoPath {
        let start = CGPoint(x: 330, y: 230)
        let rows = (0..<3).map { CGPoint(x: 31, y: 70 + CGFloat($0) * 34) }
        return LoopDemoPath(keys: [(0, start), (0.25, start), (0.75, rows[0]), (1.0, rows[0]), (1.35, rows[1]),
                                    (1.6, rows[1]), (1.95, rows[2]), (2.2, rows[2]), (2.7, CGPoint(x: 156, y: 216)),
                                    (3.0, CGPoint(x: 156, y: 216)), (3.6, CGPoint(x: 395, y: 245))])
    }

    var body: some View {
        ZStack(alignment: .topLeading) {
            chooser.frame(width: 180, height: 222).offset(x: 14, y: 14)
            library.frame(width: 178, height: 222).offset(x: 208, y: 14)
            LoopDemoPointer(at: pointer.point(time), clicks: Self.ticks + [Self.add], time: time,
                             opacity: 1 - time.ramp(3.3, 3.6))
        }
        .frame(width: LoopTourDemo.canvas.width, height: LoopTourDemo.canvas.height, alignment: .topLeading)
    }

    private var chooser: some View {
        LoopDemoWindow(title: "Choose folders") {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(Self.folders.enumerated()), id: \.offset) { index, folder in
                    let tick = index < Self.ticks.count ? time.ramp(Self.ticks[index], Self.ticks[index] + 0.3, curve: .back) : 0
                    HStack(spacing: 8) {
                        ZStack {
                            Circle().strokeBorder(LoopTourLook.ink.opacity(0.25), lineWidth: 1.2)
                            Circle().fill(LoopTourLook.blue).scaleEffect(tick)
                            Image(systemName: "checkmark").font(.system(size: 8, weight: .heavy)).foregroundStyle(.white)
                                .scaleEffect(tick)
                        }
                        .frame(width: 16, height: 16)
                        Image(systemName: "folder.fill").font(.system(size: 12)).foregroundStyle(folder.color)
                        Text(folder.name).font(LoopLook.font(11.5, .medium)).foregroundStyle(LoopTourLook.ink).lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 10)
                    .frame(height: 30)
                    .background(RoundedRectangle(cornerRadius: 7, style: .continuous)
                        .fill(LoopTourLook.blue.opacity(0.08 * min(1, tick))))
                }
                Spacer(minLength: 0)
                HStack {
                    Spacer()
                    Text("Add 3")
                        .font(LoopLook.font(11, .semibold)).foregroundStyle(.white)
                        .frame(width: 58, height: 24)
                        .background(Capsule().fill(LoopTourLook.ink.opacity(time.t >= Self.ticks[0] ? 1 : 0.3)))
                        .scaleEffect(1 - 0.08 * time.press(Self.add))
                }
            }
            .padding(6)
            .padding(.bottom, 4)
        }
    }

    private var library: some View {
        let count = Int((128 * time.ramp(Self.read, Self.ready - 0.2, curve: .out)).rounded())
        return LoopDemoWindow(title: "Lasso library") {
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text("\(count) files").font(LoopLook.font(11.5, .semibold)).foregroundStyle(LoopTourLook.ink)
                        .monospacedDigit()
                    Spacer()
                    status
                }
                .padding(.horizontal, 10)
                .frame(height: 26)
                if time.t < Self.read {
                    Text("Nothing here yet")
                        .font(LoopLook.font(11)).foregroundStyle(LoopTourLook.ink3)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ForEach(Array(Self.files.enumerated()), id: \.offset) { index, name in
                        fileRow(name, index: index)
                    }
                    Spacer(minLength: 0)
                }
            }
            .padding(.top, 4)
        }
    }

    @ViewBuilder private var status: some View {
        if time.t >= Self.ready {
            Text("Ready")
                .font(LoopLook.font(9.5, .medium)).foregroundStyle(LoopTourLook.green)
                .padding(.horizontal, 7).frame(height: 18)
                .background(Capsule().fill(LoopTourLook.green.opacity(0.12)))
                .scaleEffect(time.ramp(Self.ready, Self.ready + 0.3, curve: .back))
        } else if time.t >= Self.read {
            Text("Reading").font(LoopLook.font(9.5)).foregroundStyle(LoopTourLook.ink3)
        }
    }

    private func fileRow(_ name: String, index: Int) -> some View {
        let appear = Self.read + 0.1 + Double(index) * 0.5
        let shown = time.ramp(appear, appear + 0.3, curve: .out)
        let filled = time.ramp(appear + 0.1, appear + 0.9, curve: .linear)
        let done = time.ramp(appear + 0.9, appear + 1.15, curve: .back)
        return HStack(spacing: 7) {
            LoopFileIcon(url: nil, fileExtension: (name as NSString).pathExtension, size: 14)
            Text(name).font(LoopLook.font(10.5)).foregroundStyle(LoopTourLook.ink).lineLimit(1)
            Spacer(minLength: 4)
            ZStack(alignment: .leading) {
                Capsule().fill(LoopTourLook.line).frame(width: 28, height: 3)
                Capsule().fill(LoopTourLook.blue).frame(width: 28 * filled, height: 3)
            }
            .opacity(1 - done)
            .overlay {
                Image(systemName: "checkmark.circle.fill").font(.system(size: 11)).foregroundStyle(LoopTourLook.green)
                    .scaleEffect(done)
            }
        }
        .padding(.horizontal, 10)
        .frame(height: 27)
        .opacity(shown)
        .offset(y: 8 * (1 - shown))
    }
}
