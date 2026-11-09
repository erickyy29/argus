/**
 * Sourced reference text shown in the Risk, Environment and Night-sky panels.
 * Every item was checked against its source by an adversarial fact-check (8 Nov 2026):
 * 55 claims verified, 0 refuted; corrected or unsupported drafts were dropped.
 * Re-verify before publication — policy status (FCC Part 100, TraCSS, EU Space Act) changes quickly.
 */
export const BRIEF = {
 "verified": true,
 "verified_on": "2026-11-08",
 "pc_thresholds": {
  "red": 0.0001,
  "amber": 1e-07,
  "text": "Red: Pc > 1E-04. Detailed monitoring and mitigation planning; a mitigation action is executed in a minority of cases. Amber: Pc > 1E-07, generally more monitoring (NASA CARA). Thresholds apply to covariance-based Pc, not TLE worst-case values.",
  "source_url": "https://www.nasa.gov/wp-content/uploads/2026/08/ca-handbook-volume2-nasa-sp-20205011318-rev2-vol2.pdf?emrc=5ecf8c"
 },
 "risk_method_notes": [
  {
   "text": "Max Pc (SOCRATES MAX_PROB) is a worst-case value. The covariance ellipse is sized and oriented to give the largest Pc, with a 100/300/100 m radial/in-track/cross-track ratio and fixed spherical radii. Read it as an upper bound. It equals 1 when the combined radius exceeds the miss distance.",
   "source_url": "https://celestrak.org/SOCRATES/socrates-format.php"
  },
  {
   "text": "DILUTION (km) is the standard deviation that produces MAX_PROB. A smaller or larger σ gives a lower Pc. Above this σ is the dilution region, where a low Pc can reflect poor data rather than a safe pass. Better data, or MAX_PROB, are then needed.",
   "source_url": "https://celestrak.org/SOCRATES/socrates-format.php"
  },
  {
   "text": "In-app Pmax = R²/(e·d²) is the isotropic case: reached at σ = d/√2, valid for R ≪ d. With ellipse aspect ratio λ it becomes λR²/(e·d²). SOCRATES MAX_PROB can therefore be up to about 3× the in-app value.",
   "source_url": "https://arxiv.org/html/2302.06893"
  },
  {
   "text": "Miss distance alone is a poor risk proxy. In NASA CARA LEO data, events with Pc > 1E-04 had miss distances from under 100 m to over 10 km. A 10 km cut-off catches 95% of them but also flags more than 50% of benign events.",
   "source_url": "https://www.nasa.gov/wp-content/uploads/2026/08/ca-handbook-volume2-nasa-sp-20205011318-rev2-vol2.pdf?emrc=5ecf8c"
  },
  {
   "text": "TLE/SGP4 data have no meaningful covariance, so TLE screening gives miss distance, not a true Pc. LEO TLE errors of 600 m–3 km occur from epoch to 72 h, mostly in-track because drag is poorly modelled. NASA: public TLEs alone should not drive mitigation decisions.",
   "source_url": "https://www.nasa.gov/wp-content/uploads/2026/08/ca-handbook-volume2-nasa-sp-20205011318-rev2-vol2.pdf?emrc=5ecf8c"
  },
  {
   "text": "Operators decide manoeuvres from CDMs, which are based on special-perturbations orbits with covariance and issued by USSF 18/19 SDS via Space-Track.org. Use this app's TLE-based results for awareness and pre-filtering only.",
   "source_url": "https://www.nasa.gov/wp-content/uploads/2026/08/ca-handbook-volume2-nasa-sp-20205011318-rev2-vol2.pdf?emrc=5ecf8c"
  },
  {
   "text": "SOCRATES Plus screens active payloads against the full GP catalogue: 5 km threshold, 7-day window. The 8 Nov 2026 run took 14 h 06 m, so results can lag their input data by more than 14 h.",
   "source_url": "https://celestrak.org/SOCRATES/"
  },
  {
   "text": "Pc scales roughly with hard-body radius squared: tripling the HBR raises Pc about ninefold. NASA advises against inflating the HBR for conservatism and recommends lowering the Pc threshold instead. About 98% of conjunctions with unknown secondaries involve a mean HBR under 35 cm.",
   "source_url": "https://www.nasa.gov/wp-content/uploads/2026/08/ca-handbook-volume2-nasa-sp-20205011318-rev2-vol2.pdf?emrc=5ecf8c"
  },
  {
   "text": "Screening covers catalogued objects only. NASA cites more than 300,000 objects larger than 1 cm, the size that can disable a satellite, against an expected catalogue of 30,000–50,000. More than 85% of similarly likely collisions cannot be screened or mitigated.",
   "source_url": "https://www.nasa.gov/wp-content/uploads/2026/08/ca-handbook-volume2-nasa-sp-20205011318-rev2-vol2.pdf?emrc=5ecf8c"
  },
  {
   "text": "NASA CARA judges event severity at the manoeuvre commitment point, typically 12–24 h before TCA for modern satellites.",
   "source_url": "https://www.nasa.gov/wp-content/uploads/2026/08/ca-handbook-volume2-nasa-sp-20205011318-rev2-vol2.pdf?emrc=5ecf8c"
  },
  {
   "text": "CelesTrak's documentation (2023) says SOCRATES Plus no longer screens intra-fleet pairs among fully operational satellites, because operators see their own fleets more accurately. The current report still lists Starlink↔Starlink approaches, so treat that share as reported, not complete.",
   "source_url": "https://celestrak.org/SOCRATES/"
  }
 ],
 "sustainability_levers": [
  {
   "title": "Five-year post-mission disposal",
   "detail": "FCC 22-74: LEO satellites (below 2,000 km) using uncontrolled re-entry must deorbit within 5 years of end of mission if launched after 29 Sep 2024. ESA's 2023 requirements also set 5 years. The IADC guideline remains 25 years.",
   "source_url": "https://docs.fcc.gov/public/attachments/FCC-22-74A1.txt"
  },
  {
   "title": "Near-100% disposal reliability",
   "detail": "In the last decade, only 15–60% of payloads that ended life in non-compliant LEO orbits attempted disposal, and 5–50% succeeded within 25 years. ESA says the common 90% disposal-success target must rise to near 100%.",
   "source_url": "https://www.sdo.esoc.esa.int/environment_report/Space_Environment_Report_latest.pdf"
  },
  {
   "title": "Passivation at end of life",
   "detail": "ESA: non-collision fragmentations are the dominant debris source, with 661 events to end-2025 and propulsion causing about 43% in the last decade. Passivation targets these causes by depleting propellant, venting pressurants and permanently discharging batteries.",
   "source_url": "https://www.sdo.esoc.esa.int/environment_report/Space_Environment_Report_latest.pdf"
  },
  {
   "title": "Ephemeris and manoeuvre data sharing",
   "detail": "FCC Part 100 (adopted 22 Jul 2026; effective date pending) requires ephemerides, including covariance for planned manoeuvres, sent to 18 SDS. It encourages updates every 8 h in LEO and requires semi-annual NGSO safety reports.",
   "source_url": "https://docs.fcc.gov/public/attachments/FCC-26-47A1.pdf"
  },
  {
   "title": "Coordinated civil conjunction screening",
   "detail": "NOAA's TraCSS provides free basic screening and CDMs: All-vs-All twice daily, Payload-vs-All four times daily, with LEO volumes matching 19 SDS. It is taking over from USSF under SPD-3. The handover is in progress; TraCSS was still a pilot in Aug 2026.",
   "source_url": "https://www.space.commerce.gov/wp-content/uploads/2026/02/TraCSS-User-Handbook-Master-Draft-optimized.pdf"
  },
  {
   "title": "Mandatory collision-avoidance capability",
   "detail": "The proposed EU Space Act (25 Jun 2025) would require constellations of 10 or more spacecraft to be capable of active collision avoidance. It would apply from 1 Jan 2030. The proposal was still under negotiation in mid-2026.",
   "source_url": "https://www.cooley.com/news/insight/2025/2025-07-24-the-proposed-eu-space-act-10-key-implications-us-and-non-eu-satellite-operators-should-know"
  },
  {
   "title": "Low, fast-decaying shells",
   "detail": "SpaceX is lowering about 4,400 Starlinks from about 550 km to about 480 km during 2026. SpaceX says this cuts ballistic decay time at solar minimum by more than 80%, from over 4 years to a few months. Completion is unconfirmed.",
   "source_url": "https://www.theregister.com/2026/01/02/starlink_lower_orbits/"
  },
  {
   "title": "Remove massive derelicts",
   "detail": "The 2025 Top 50 list of statistically most concerning LEO derelicts ranks an SL-16 rocket body first and Envisat second. Removing all 50 would roughly halve LEO's debris-generating potential; removing the top 10 would cut it by about a third.",
   "source_url": "https://heise.de/-10728122"
  },
  {
   "title": "Brightness and dark-and-quiet-sky limits",
   "detail": "IAU CPS: operational LEO satellites should be fainter than V = 7 (altitude-scaled above 550 km) over their full mission lifetime, including orbit raising and de-orbit. Orbits should stay below about 600 km to limit visibility in the darkest hours.",
   "source_url": "https://arxiv.org/abs/2412.08244"
  }
 ],
 "environment_facts": [
  {
   "text": "CelesTrak SATCAT Boxscore (8 Nov 2026): 35,504 objects on orbit. These are 20,517 payloads (17,479 active) and 14,987 rocket bodies and debris. 71,295 objects have been catalogued in total, 35,791 of them decayed.",
   "source_url": "https://celestrak.org/satcat/boxscore.php"
  },
  {
   "text": "ESA MASTER-8 (Feb 2026) estimates 68,450 objects larger than 10 cm (about 11,300 active payloads), 1.5 million of 1–10 cm and 230 million of 1 mm–1 cm. ESA lists about 47,340 objects as regularly tracked.",
   "source_url": "https://sdup.esoc.esa.int/discosweb/statistics/"
  },
  {
   "text": "ESA 2026: under business as usual, the LEO health index is projected at about 50× the sustainability threshold, up from about 4× a year earlier. LEO debris would keep growing even with no further launches. ESA: ADR 'must become part of the solution and soon'.",
   "source_url": "https://www.esa.int/Space_Safety/Space_Debris/ESA_Space_Environment_Report_2026"
  },
  {
   "text": "In 2025: more than 300 launches, more than 4,000 new payloads, and about 1,200 intact re-entries (1,117 payloads, 108 rocket bodies), an average of more than 3 per day.",
   "source_url": "https://www.esa.int/Space_Safety/Space_Debris/ESA_Space_Environment_Report_2026"
  },
  {
   "text": "ESA identifies the 400–600 km band as needing effective space-traffic coordination. The rise in projected long-term risk is driven mainly by growth from large constellation deployments.",
   "source_url": "https://www.sdo.esoc.esa.int/environment_report/Space_Environment_Report_latest.pdf"
  },
  {
   "text": "SpaceX reported 207,152 Starlink collision-avoidance manoeuvres from 1 Dec 2025 to 31 May 2026: about 36 per Gen1 and 46 per Gen2 satellite per year. SpaceX manoeuvres at Pc > 3E-07, against an industry standard of 1E-04.",
   "source_url": "https://api-prod.fcc.gov/icfs-attachment/exp/api/v1/bff0244acfb947505791bf252f851ce6"
  },
  {
   "text": "CRASH Clock: if all satellites stopped manoeuvring, the expected time to a catastrophic LEO collision was 5.5 days in June 2025, against 164 days in 2018 (Thiele et al., arXiv:2512.09643 v3).",
   "source_url": "https://arxiv.org/abs/2512.09643"
  },
  {
   "text": "Kessler & Cour-Palais (JGR, June 1978) showed that fragments from random collisions could make debris flux grow exponentially, even with zero net input to the catalogue.",
   "source_url": "https://aquarid.physics.uwo.ca/kessler/Kessler%20Syndrome-AAS%20Paper.pdf"
  },
  {
   "text": "Solar Cycle 25's smoothed sunspot number peaked at 161 in October 2024; the 2019 panel had forecast 105–125. Higher activity raises drag. As activity declines toward solar minimum, orbital lifetimes lengthen again.",
   "source_url": "https://sidc.be/article/solar-cycle-25-reached-its-maximum-october-2024"
  },
  {
   "text": "Of LEO payloads under 1,000 kg that ended their mission since 2020, 88–99% are in orbits that naturally meet the 25-year rule, against only 54% of larger payloads.",
   "source_url": "https://www.sdo.esoc.esa.int/environment_report/Space_Environment_Report_latest.pdf"
  },
  {
   "text": "Since the start of 2024, 26 rocket bodies have been left in LEO with lifetimes over 25 years. 21 of them are Chinese, mostly from Guowang and Qianfan launches.",
   "source_url": "https://heise.de/-10728122"
  }
 ],
 "fragmentation_events": [
  {
   "name": "Fengyun-1C ASAT test",
   "date": "2007-01-11",
   "altitude_km": "845 × 865 (98.6°)",
   "tracked_fragments": "3,531 catalogued; 2,310 on orbit (SATCAT, 8 Nov 2026)",
   "source_url": "https://celestrak.org/satcat/records.php?INTDES=1999-025&FORMAT=JSON",
   "intdes": [
    "1999-025"
   ]
  },
  {
   "name": "Iridium 33 – Cosmos 2251 collision",
   "date": "2009-02-10",
   "altitude_km": "790",
   "tracked_fragments": "2,370 catalogued (1,714 Cosmos + 656 Iridium); 720 on orbit",
   "source_url": "https://celestrak.org/satcat/records.php?INTDES=1997-051&FORMAT=JSON",
   "intdes": [
    "1997-051",
    "1993-036"
   ]
  },
  {
   "name": "Cosmos 1408 ASAT test",
   "date": "2021-11-15",
   "altitude_km": "~465 × 490",
   "tracked_fragments": "1,806 catalogued; 3 on orbit",
   "source_url": "https://celestrak.org/satcat/records.php?INTDES=1982-092&FORMAT=JSON",
   "intdes": [
    "1982-092"
   ]
  },
  {
   "name": "CZ-6A upper stage (first Qianfan launch, 2024-140)",
   "date": "2024-08-06",
   "altitude_km": "not in verified sources",
   "tracked_fragments": "705 catalogued; 573 on orbit",
   "source_url": "https://celestrak.org/satcat/records.php?INTDES=2024-140&FORMAT=JSON",
   "intdes": [
    "2024-140"
   ]
  }
 ],
 "planned_constellations": [
  {
   "name": "Starlink",
   "operator": "SpaceX",
   "planned": "4,408 Gen1 + 15,000 Gen2 authorised (14,988 more deferred); a 1,000,000-satellite application filed 30 Jan 2026 is pending",
   "status_note": "13,096 launched, 11,207 in orbit (McDowell, 7 Nov 2026). About 4,400 being lowered from ~550 km to ~480 km during 2026.",
   "source_url": "https://docs.fcc.gov/public/attachments/DOC-417881A1.txt"
  },
  {
   "name": "Amazon Leo (formerly Project Kuiper)",
   "operator": "Amazon",
   "planned": "3,232 authorised, all due by 30 Jul 2029",
   "status_note": "396 production satellites launched (latest 2 Jul 2026), plus 2 prototypes. The FCC granted a conditional waiver for the 1,616-satellite milestone (DA 26-553, 5 Jun 2026).",
   "source_url": "https://docs.fcc.gov/public/attachments/DOC-417881A1.txt"
  },
  {
   "name": "OneWeb Gen1",
   "operator": "Eutelsat",
   "planned": "669 replacement satellites on order from Airbus",
   "status_note": "656 launched, 654 in orbit (SATCAT). The replacement order figure comes from search results.",
   "source_url": "https://docs.fcc.gov/public/attachments/DOC-417881A1.txt"
  },
  {
   "name": "Guowang",
   "operator": "China",
   "planned": "12,992 in Sep 2020 ITU filings (GW-A59 6,080 + GW-2 6,912)",
   "status_note": "SATCAT lists 231 'Hulianwang Digui' satellites plus 22 'Hulianwang Jishu Shiyan' test satellites.",
   "source_url": "https://docs.fcc.gov/public/attachments/DOC-417881A1.txt"
  },
  {
   "name": "Qianfan",
   "operator": "China",
   "planned": "~15,000 by 2030 (as reported)",
   "status_note": "248 named satellites plus 27 not yet identified, from 17 launches (latest 3 Nov 2026).",
   "source_url": "https://docs.fcc.gov/public/attachments/DOC-417881A1.txt"
  }
 ],
 "night_sky_notes": [
  {
   "text": "Hainaut (A&A 2026): about 60,000 satellites meeting the V = 7 limit add only about 10⁻⁴ to natural sky brightness. The total population should stay below about 100,000; proposed constellations exceed 1.7 million.",
   "source_url": "https://www.eso.org/public/archives/releases/sciencepapers/eso2607/eso2607a.pdf"
  },
  {
   "text": "Most measured constellations exceed the IAU research limit. OneWeb is the only active constellation whose mean apparent brightness is fainter (Mallama & Cole, updated 3 Aug 2026).",
   "source_url": "https://satmags.netlify.app"
  },
  {
   "text": "Constellations below about 600 km sit in Earth's shadow around local midnight at mid-latitudes, so their impact falls mostly on twilight observing. Constellations near 1,200 km can be visible all night in summer.",
   "source_url": "https://planet4589.org/jcm/pubs/space/papers/2020/SATCON1-Report.pdf"
  },
  {
   "text": "Tyson et al. (2020): with 48,000 LEO satellites at 550 km, about 30% of LSST images would contain a trail, and up to 90% of twilight exposures. Constellations at 1,200 km would raise this about tenfold.",
   "source_url": "https://arxiv.org/pdf/2006.12417"
  },
  {
   "text": "Rubin Observatory (FAQ, 22 Jul 2026): with 40,000 LEO satellites, about 10% of LSST images would contain a trail, as would most twilight images. Streak pixels are masked from deep coadds.",
   "source_url": "https://rubinobservatory.org/for-scientists/frequently-asked-questions/leo-sats"
  },
  {
   "text": "Hubble: 2.7 ± 0.2% of exposures from 2002–2021 contain a satellite trail. For ACS/WFC the share rose from 2.8% (2002–2005) to 4.3% (2018–2021) (Kruk et al. 2023).",
   "source_url": "https://www.theregister.com/2023/03/03/hubble_satellite_interference/"
  },
  {
   "text": "Borlaff et al. (Nature, Dec 2025): a projected population of about 560,000 satellites would put trails in about 39.6% of Hubble images and about 96% of SPHEREx, ARRAKIHS and Xuntian images.",
   "source_url": "https://www.natureasia.com/en/info/press-releases/detail/9170"
  },
  {
   "text": "Starlink V2 Mini satellites emit unintended broadband radio emission up to 32× stronger than V1.0/V1.5. It exceeds ITU-R thresholds protecting the 150.05–153 MHz radio-astronomy band (Bassa et al. 2024, LOFAR).",
   "source_url": "https://arxiv.org/abs/2409.11767"
  },
  {
   "text": "Sunlight scattered by satellites and debris may already raise diffuse zenith sky-glow by about 10% (~20 µcd/m²). This is the 1979 IAU critical limit for observatory sites (Kocifaj et al. 2021).",
   "source_url": "https://arxiv.org/abs/2103.17125"
  },
  {
   "text": "In a model of 65,000 satellites, latitudes near 50° N and 50° S are most affected. Near the summer solstice, satellites would make up a few percent of visible point sources all night (Lawler et al. 2022).",
   "source_url": "https://arxiv.org/abs/2109.04328"
  }
 ],
 "brightness_limit": {
  "formula_text": "V > 7.0 for h ≤ 550 km; V > 7.0 + 2.5·log10(h / 550 km) for h > 550 km (IAU CPS; photopic or Johnson V; applies on a best-efforts basis at first)",
  "v_limit_at_550km": 7,
  "source_url": "https://arxiv.org/abs/2412.08244"
 },
 "std_magnitudes": [
  {
   "family": "Starlink Mini (475 km)",
   "value": "6.07 apparent / 7.35 at 1,000 km",
   "basis": "Mean measured magnitude, range-adjusted to 1,000 km; not phase-normalised; unpublished data",
   "source_url": "https://satmags.netlify.app"
  },
  {
   "family": "Starlink Mini (550 km, discontinued)",
   "value": "6.36 apparent / 7.22 at 1,000 km",
   "basis": "Mean measured magnitude, range-adjusted to 1,000 km",
   "source_url": "https://satmags.netlify.app"
  },
  {
   "family": "Starlink Mini Direct-to-Cell (350 km)",
   "value": "4.80 apparent / 6.74 at 1,000 km",
   "basis": "Mean measured magnitude, range-adjusted to 1,000 km",
   "source_url": "https://satmags.netlify.app"
  },
  {
   "family": "Starlink V1.0 (550 km, discontinued)",
   "value": "5.05 apparent / 5.89 at 1,000 km",
   "basis": "Mean measured magnitude, range-adjusted to 1,000 km",
   "source_url": "https://satmags.netlify.app"
  },
  {
   "family": "Amazon Leo (630 km)",
   "value": "6.22 apparent / 6.86 at 1,000 km",
   "basis": "Mean measured magnitude, range-adjusted to 1,000 km",
   "source_url": "https://satmags.netlify.app"
  },
  {
   "family": "OneWeb (1,200 km)",
   "value": "7.98 apparent / 7.41 at 1,000 km",
   "basis": "Mean measured magnitude, range-adjusted to 1,000 km",
   "source_url": "https://satmags.netlify.app"
  },
  {
   "family": "Qianfan (1,070 km)",
   "value": "5.86 apparent / 5.42 at 1,000 km",
   "basis": "Mean measured magnitude, range-adjusted to 1,000 km",
   "source_url": "https://satmags.netlify.app"
  },
  {
   "family": "Guowang (1,166 km)",
   "value": "4.57 apparent / 4.04 at 1,000 km",
   "basis": "Mean measured magnitude, range-adjusted to 1,000 km; unpublished data",
   "source_url": "https://satmags.netlify.app"
  },
  {
   "family": "AST BlueBird Block 2 (500 km)",
   "value": "3.80 apparent / 4.27 at 1,000 km",
   "basis": "Mean measured magnitude, range-adjusted to 1,000 km",
   "source_url": "https://satmags.netlify.app"
  },
  {
   "family": "Cosmos rocket body (typical)",
   "value": "5.5 Molczan standard (4.0 QuickSat intrinsic)",
   "basis": "Molczan: mean magnitude at 1,000 km and 90° phase. QuickSat: maximum at full phase, about 1.5 mag brighter.",
   "source_url": "https://www.satobs.org/brite.html"
  }
 ],
 "decay_statement": {
  "text": "Debris below 600 km normally re-enters within several years. At 800 km, orbital decay often takes centuries. Above 1,000 km, debris normally remains in orbit for 1,000 years or more (NASA ODPO).",
  "source_url": "https://orbitaldebris.jsc.nasa.gov/faq/"
 },
 "caveats": [
  "No verified claim supports an ASAT-test moratorium lever, so none is included. Fengyun-1C and Cosmos 1408 appear only as fragmentation events.",
  "CARA red/amber thresholds apply to covariance-based Pc from CDMs. In-app TLE-derived Max Pc is an upper bound, and comparing it to these thresholds is a screening aid, not a decision basis.",
  "The in-app isotropic Pmax will not generally match SOCRATES MAX_PROB, which can be up to about 3× larger because of the 100:300:100 m RIC aspect ratio.",
  "Catalogue counts are a snapshot from 8 Nov 2026. Live SATCAT values will differ. ESA's ~47,340 tracked objects exceed the US public catalogue partly because ESA includes other networks.",
  "FCC Part 100 was adopted on 22 Jul 2026, but its effective date had not been announced as of late Oct 2026. Part 25 remains in force until then.",
  "TraCSS status (pilot, Aug 2026) and the EU Space Act (not adopted as of mid-2026) may have changed. The SOCRATES three-runs-per-day cadence (2023 page) may be outdated.",
  "Fragmentation counts come from per-designator SATCAT queries (1999-025, 1993-036/1997-051, 1982-092, 2024-140). Only the 1999-025 URL was supplied, so it is cited for all four events. The CZ-6A breakup altitude is not verified.",
  "Guowang and Qianfan operators are not named in the verified claims. The Qianfan ~15,000 target, the Eutelsat 669-satellite order, the Starlink lowering date and the 1M-satellite filing rest on press or search results.",
  "Satmags 1,000-km magnitudes are range-adjusted only, not phase-normalised. They are not equivalent to Molczan standard magnitudes (1,000 km, 90° phase). Guowang, V1.5 and Mini-475 values come from unpublished data.",
  "BlueWalker 3 (peak apparent magnitude 0.4; Nandakumar et al. 2023, Nature 623) is not in the satmags table, so it is omitted from std_magnitudes.",
  "If the brightness model uses the diffuse-sphere phase law m = m_std + 5·log10(d/1000) − 2.5·log10[sin φ + (π − φ)·cos φ], label it a standard approximation. It was only mathematically checked, with no source (https://www.satobs.org/brite.html gives the conventions).",
  "Use the CRASH Clock values from v3 (5.5 days, 164 days), not the v1 figures. Starlink lowering completion is unconfirmed as of Nov 2026.",
  "The decay_statement uses NASA ODPO wording only. Solar-cycle dependence (shorter lifetimes near maximum) is a separate claim sourced to SIDC."
 ]
};
