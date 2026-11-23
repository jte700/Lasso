import math
G="#29cc57"; INK="#141413"; PAPER="#f5f3f1"
def bez(p0,p1,p2,p3,t):
    u=1-t; return tuple(u**3*a+3*u*u*t*b+3*u*t*t*c+t**3*d for a,b,c,d in zip(p0,p1,p2,p3))
def rope_marks(pts, w, col, step=9.5):
    # pts: dense polyline; place twist marks every `step` along it
    out=[]; acc=0
    for (x0,y0),(x1,y1) in zip(pts,pts[1:]):
        L=math.hypot(x1-x0,y1-y0); acc+=L
        if acc>=step:
            acc=0; ang=math.degrees(math.atan2(y1-y0,x1-x0))
            h=w*0.5
            out.append(f'<line x1="{-h*0.55:.2f}" y1="{-h:.2f}" x2="{h*0.55:.2f}" y2="{h:.2f}" transform="translate({x1:.2f} {y1:.2f}) rotate({ang:.1f})"/>')
    return f'<g stroke="{col}" stroke-width="1.6" stroke-linecap="round" opacity=".32">{"".join(out)}</g>'
def emblem(bg, ink, catch):
    cx,cy,R,W=100,86,58,14
    ring=[(cx+R*math.cos(math.radians(a/4)),cy+R*math.sin(math.radians(a/4))) for a in range(0,1441)]
    # knot at 60 deg (lower right)
    ka=math.radians(112); kx,ky=cx+R*math.cos(ka),cy+R*math.sin(ka)
    P=[(kx,ky),(kx-14,ky+30),(kx+46,ky+20),(kx+58,ky+50)]
    tail=[bez(*P,i/200) for i in range(201)]
    tpath='M%.1f %.1f C%.1f %.1f %.1f %.1f %.1f %.1f'%tuple(c for p in P for c in p)
    s=[f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">']
    if bg: s.append(f'<rect width="200" height="200" rx="44" fill="{bg}"/>')
    s.append(f'<circle cx="{cx}" cy="{cy}" r="{R}" fill="none" stroke="{G}" stroke-width="{W}"/>')
    s.append(rope_marks(ring,W,ink))
    s.append(f'<path d="{tpath}" fill="none" stroke="{G}" stroke-width="{W-2}" stroke-linecap="round"/>')
    s.append(rope_marks(tail,W-2,ink))
    # honda: a small loop the rope runs through
    s.append(f'<ellipse cx="{kx:.1f}" cy="{ky:.1f}" rx="13" ry="9" transform="rotate({math.degrees(ka)+90+25:.1f} {kx:.1f} {ky:.1f})" fill="{G}" stroke="{ink}" stroke-width="3.5"/>')
    if catch:
        # the caught fragment: a document with folded corner, tilted
        s.append(f'<g transform="translate(0 -10) rotate(-8 100 96)"><path d="M82 70 H108 L122 84 V122 H82 Z" fill="{ink}"/><path d="M108 70 V84 H122" fill="none" stroke="{bg or PAPER}" stroke-width="3" stroke-linejoin="round"/>'
                 f'<rect x="90" y="96" width="24" height="5" rx="2.5" fill="{G}"/></g>')
    s.append('</svg>'); return "".join(s)
open("lasso-emblem.svg","w").write(emblem(None,INK,True))
open("lasso-emblem-dark.svg","w").write(emblem(INK,PAPER,True))
open("lasso-emblem-plain.svg","w").write(emblem(None,INK,False))
